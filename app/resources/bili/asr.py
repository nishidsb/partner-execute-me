"""faster-whisper batch transcribe for bili duty (S9-M3).

Usage: python asr.py <audio> <model>
Prints exactly ONE JSON line on stdout:
  {"ok":true,"text":"...","durationSec":12.3}
  {"ok":false,"error":"..."}
Model files download from HF_ENDPOINT (set https://hf-mirror.com by the host).
"""
import io
import json
import os
import sys


def _patch_av():
    """PyAV 19 移除了 av.open(metadata_errors=...) 参数，而 faster-whisper 1.2.x
    仍会传它 → TypeError: open() got an unexpected keyword argument 'metadata_errors'
    （表现为「语音识别失败」，但模型其实早就加载好了，卡在解码这一步）。
    这里把不认识的元数据错误策略参数吃掉，兼容新旧两代 PyAV。"""
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

# 只认中/英/日（其它语言不需要）；自动模式判到别的语种就按普通话重来一次
ALLOWED_LANGS = ("zh", "en", "ja")

# 与 asr_serve.py 同一套推理参数（速度优先，实测 2s 短句 ~1.3s）
BASE_KW = {
    "vad_filter": True,
    "vad_parameters": dict(min_silence_duration_ms=300),
    "beam_size": 1,
    "without_timestamps": True,
    "condition_on_previous_text": False,
}


def cpu_threads():
    n = os.cpu_count() or 4
    if n <= 4:
        return 2
    return max(2, min(8, n - 2))


def _t2s(text):
    """同 asr_serve.py：whisper 中文输出常年是繁体，转成简体（没装 opencc 就原样返回）。"""
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
    try:
        audio = sys.argv[1]
        model = sys.argv[2] if len(sys.argv) > 2 else "small"
        # 第三个参数是语言（auto/zh/ja/en…）。以前写死 language=None，
        # 中文短句经常被自动检测成英语（"喂莱莎" → "Eh? Nanindang ma?"）。
        lang = (sys.argv[3] if len(sys.argv) > 3 else "auto") or "auto"
        _patch_av()
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            print(json.dumps({"ok": False, "error": "faster-whisper not installed in this venv"}, ensure_ascii=False))
            return 2
        wm = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=cpu_threads())
        text, det, dur = run_one(wm, audio, lang)
        if lang not in ALLOWED_LANGS and det not in ALLOWED_LANGS:
            text, det, dur = run_one(wm, audio, "zh")
        print(json.dumps({"ok": True, "text": text, "language": det, "durationSec": dur}, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1

if __name__ == "__main__":
    # stderr may carry download progress; host only parses the last stdout line
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
