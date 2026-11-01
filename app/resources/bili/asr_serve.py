"""faster-whisper 常驻转写服务（0.18.0 语音输入提速）。

一次性 asr.py 每次都要重新加载模型（CPU 上 4~6 秒），常开麦克风下每句话都要等
8~15 秒，体验极差。这个服务把模型加载一次常驻，之后每句只做推理。

用法:  python asr_serve.py <model>
启动后先输出一行 {"ok":true,"ready":true,"model":"small"}（模型加载完才输出）。
之后每行 stdin 一个 JSON 请求：
    {"audio":"C:\\\\path\\\\a.webm","language":"zh"}
    language 省略或 "auto" = 自动检测
每行 stdout 回一行 JSON：
    {"ok":true,"text":"...","durationSec":1.2}
    {"ok":false,"error":"..."}
stdin 关闭或收到 {"cmd":"quit"} 时退出。
"""
import io
import json
import os
import sys


def _patch_av():
    """PyAV 19 移除了 av.open(metadata_errors=...)，faster-whisper 1.2.x 还在传。
    不改 venv 里的包，这里吃掉这个参数（与 asr.py 同一处补丁）。"""
    try:
        import av
    except Exception:
        return
    orig = getattr(av, "open", None)
    if orig is None or getattr(orig, "_ryza_av_compat", False):
        return

    def open_compat(file, mode="r", **kw):
        kw.pop("metadata_errors", None)
        return orig(file, mode=mode, **kw)

    open_compat._ryza_av_compat = True
    av.open = open_compat


PROMPTS = {
    "zh": "以下是普通话的句子。",
    "ja": "以下是日语对话。",
    "en": "The following is an English conversation.",
}

# 只认这三种语言（主人 2026-10-26 拍板：中/英/日，其它不需要）。
# 自动模式下 whisper 会从 99 种语言里挑，偶尔会判成粤语/韩语 → 强制按普通话重来一次。
ALLOWED_LANGS = ("zh", "en", "ja")

# 推理参数：短句都是「固定成本」（whisper 恒按 30s 窗口编码），能省的只有解码与后处理
BASE_KW = {
    "vad_filter": True,
    "vad_parameters": dict(min_silence_duration_ms=300),  # 尾巴静音快剪掉
    "beam_size": 1,
    "without_timestamps": True,                            # 不预测时间戳 = 少一批解码
    "condition_on_previous_text": False,                   # 单句识别，不需要上文（也防复读）
}


def cpu_threads():
    """CPU 线程数：实测 12 核机器 8 线程最快（2s 短句 1.7s → 1.3s），
    留几核给界面/TTS，别把整机吃满。"""
    n = os.cpu_count() or 4
    if n <= 4:
        return 2
    return max(2, min(8, n - 2))


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _t2s(text):
    """whisper 中文输出常年是繁体（模型训练语料里繁体多），主人要简体。
    装了 opencc（opencc-python-reimplemented）就转，没装就原样返回，绝不报错。"""
    if not text:
        return text
    try:
        from opencc import OpenCC
        if not hasattr(_t2s, "_cc"):
            _t2s._cc = OpenCC("t2s")
        return _t2s._cc.convert(text)
    except Exception:
        return text


def run_one(wm, audio, lang):
    """跑一次转写，返回 (text, detected_language, duration)"""
    kw = dict(BASE_KW)
    if lang in ALLOWED_LANGS:
        kw["language"] = lang
        kw["initial_prompt"] = PROMPTS[lang]
    segments, info = wm.transcribe(audio, **kw)
    parts = []
    for seg in segments:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)
    return _t2s("\n".join(parts)), (getattr(info, "language", "") or ""), float(getattr(info, "duration", 0) or 0)


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "small"
    _patch_av()
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"ok": False, "error": "faster-whisper not installed in this venv", "fatal": True})
        return 2
    try:
        wm = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=cpu_threads())
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": "模型加载失败: %s" % e, "fatal": True})
        return 1

    emit({"ok": True, "ready": True, "model": model, "threads": cpu_threads()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            emit({"ok": False, "error": "请求不是合法 JSON"})
            continue
        if req.get("cmd") == "quit":
            break
        audio = req.get("audio") or ""
        lang = (req.get("language") or "auto").strip()
        try:
            text, det, dur = run_one(wm, audio, lang)
            # 自动检测跑到中英日之外（粤语/韩语/俄语…）→ 按普通话重来一次
            if lang not in ALLOWED_LANGS and det not in ALLOWED_LANGS:
                text, det, dur = run_one(wm, audio, "zh")
            emit({
                "ok": True,
                "text": text,
                "language": det,
                "durationSec": dur,
            })
        except Exception as e:  # noqa: BLE001
            emit({"ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
        sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
