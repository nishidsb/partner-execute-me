"""屏幕字幕 OCR 常驻服务（Ryza 0.34.0）。

为什么要它：她的模型是 deepseek-flash，**没有视觉**。看屏陪伴那条「截图喂视觉模型」的路
在当前配置下必然 400。但看片的时候屏幕上本来就有字幕——把那一行**读成文字**塞进上下文，
既不需要视觉模型，也不花一个图片 token。

和鱼搭子（dsh-fish-buddy）那边的区别：
  · 那边自己用 PIL ImageGrab 抓屏（要装 Pillow、要处理多屏 DPI 换算）；
  · 这边**由 Electron 抓屏后把原始 RGB 像素扔进来**（w/h/rgb 三个字段），
    python 只用 numpy —— 不依赖 PIL，坐标天然跟 Electron 的 DIP 空间对齐，
    也不会出现「两个 DPI 来源打架」那类问题。
  · 引擎仍是 PP-OCRv6 small（检测 9.5MB + 识别 21MB，Apache-2.0），
    检测概率图**用 numpy 行列投影切行**，不引入 opencv。

用法：python ocr_serve.py <模型目录>
启动后先输出一行 {"ok":true,"ready":true,"det":"...","rec":"..."}（模型加载完才输出）。
之后每行 stdin 一个 JSON 请求，每行 stdout 回一行 JSON：
    {"cmd":"read","w":600,"h":80,"bgra":"<base64，BGRA8888，长度 = w*h*4>"}
        → {"ok":true,"text":"认出来的那一行","lines":2,"ms":72}
        → {"ok":true,"text":"","lines":0}     （这一帧没字，不是坏了）
    {"cmd":"ping"} → {"ok":true,"ready":true}
    {"cmd":"quit"} / stdin 关闭 → 退出

为什么收 BGRA：Electron 的 nativeImage / GDI BitBlt 出来的原始位图就是这个顺序，
中间不做任何转换直接 base64 过来最省（600×80 的条子 192KB，1.2 秒一次毫无压力）。
也留了 rgb（RGB888，w*h*3）这个口子，方便单独拿图片调试。
"""
import base64
import json
import os
import sys
import threading
import time

import numpy as np

DET_FILE = 'PP-OCRv6_det_small.onnx'
REC_FILE = 'PP-OCRv6_rec_small.onnx'

# 检测参数（照抄鱼搭子实测值，别乱调）
DET_SIDE = 640          # 压到长边 640
DET_THRESH = 0.3        # 概率图阈值
DET_MIN_RATIO = 0.02    # 一行至少占这么高比例的像素才算
DET_GAP_RATIO = 0.012   # 行距小于这个比例 → 算同一行
REC_HEIGHT = 48         # 识别统一高 48


def clean(t):
    """去掉首尾不是字的残渣（字幕淡入那两帧会带 `0那你就…` 这种）。"""
    t = (t or '').strip()
    if len(t) >= 4 and t[0] == '0' and t[1].isalnum() and ord(t[1]) > 127:
        t = t[1:]
    left, right = 0, len(t)
    while left < right and not (t[left].isalnum() or t[left] in '「『（(【'):
        left += 1
    while right > left and not (t[right - 1].isalnum() or t[right - 1] in '」』）)】'):
        right -= 1
    t = t[left:right]
    return t if word_count(t) >= 2 else ''


def word_count(t):
    return sum(1 for ch in t if ch.isalnum())


def kana_count(t):
    return sum(1 for ch in (t or '') if '\u3040' <= ch <= '\u30ff')


def is_japanese(t):
    """有假名且占比不低 → 当日本那行（中日双语字幕时用来分家）。"""
    n = word_count(t)
    if n < 2:
        return False
    return kana_count(t) / float(n) >= 0.15


def pick_line(lines):
    """几行里挑该交出去的那行：**有中文就中文**，只剩日文才用日文。

    同一句的中日两行都发一遍，看着就是重复。
    """
    if not lines:
        return ''
    zh = [x for x in lines if not is_japanese(x)]
    chosen = zh or list(lines)
    return max(chosen, key=lambda x: (word_count(x), len(x)))


class Reader:
    """检测 + 识别。模型第一次用的时候才加载。"""

    def __init__(self, model_dir):
        self.dir = model_dir
        self._det = None
        self._rec = None
        self._chars = None
        self._lock = threading.Lock()

    def start(self):
        if self._det is not None:
            return
        import onnxruntime as ort
        opts = ort.SessionOptions()
        # 陪看是长期低优先级的活，别跟前台程序抢 CPU
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        providers = ['CPUExecutionProvider']
        self._det = ort.InferenceSession(os.path.join(self.dir, DET_FILE), sess_options=opts, providers=providers)
        self._rec = ort.InferenceSession(os.path.join(self.dir, REC_FILE), sess_options=opts, providers=providers)
        table = self._rec.get_modelmeta().custom_metadata_map.get('character') or ''
        self._chars = [''] + table.split('\n')      # 0 是 CTC 的 blank

    # ---------- 对外 ----------
    def read(self, rgb, w, h):
        """rgb = uint8 的 H×W×3 数组。返回 (那一行字, 认出来的行数)。"""
        with self._lock:
            self.start()
            a = np.ascontiguousarray(rgb.reshape(h, w, 3))
            found = []
            for box in self._find_lines(a):
                top, bottom, left, right = box
                text = clean(self._recognize(a[top:bottom, left:right]))
                if text:
                    found.append(text)
            if not found:
                return '', 0
            return pick_line(found), len(found)

    # ---------- 检测：概率图 → 行投影 ----------
    def _find_lines(self, a):
        h, w = a.shape[:2]
        scale = DET_SIDE / float(max(h, w))
        nw = max(32, int(np.ceil(w * scale / 32.0)) * 32)
        nh = max(32, int(np.ceil(h * scale / 32.0)) * 32)
        small = np.asarray(_resize(a, nw, nh), dtype=np.float32) / 255.0
        small = (small - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        prob = self._det.run(None, {'x': small.transpose(2, 0, 1)[None, ...]})[0][0, 0]
        enough = max(2, int(nh * DET_MIN_RATIO))
        rows = np.where((prob > DET_THRESH).sum(axis=1) >= enough)[0]
        if not len(rows):
            return []
        gap = max(3, int(nh * DET_GAP_RATIO))
        spans = []
        begin = last = int(rows[0])
        for i in rows[1:]:
            i = int(i)
            if i - last <= gap:
                last = i
            else:
                spans.append((begin, last))
                begin = last = i
        spans.append((begin, last))
        sy, sx = nh / float(h), nw / float(w)
        out = []
        for top, bottom in spans:
            band = prob[top:bottom + 1, :]
            cols = np.where((band > DET_THRESH).sum(axis=0) >= 2)[0]
            if not len(cols):
                continue
            pt = max(0, int(top / sy) - 8)
            pb = min(h, int(bottom / sy) + 9)
            pl = max(0, int(cols[0] / sx) - 10)
            pr = min(w, int(cols[-1] / sx) + 12)
            if pr - pl < 8 or pb - pt < 8:
                continue
            out.append((pt, pb, pl, pr))
        return out

    # ---------- 识别：单行 → 高 48、等比宽 ----------
    def _recognize(self, a):
        h, w = a.shape[:2]
        nw = max(8, int(round(w * REC_HEIGHT / max(1, h))))
        img = np.asarray(_resize(a, nw, REC_HEIGHT), dtype=np.float32)
        img = (img / 255.0 - 0.5) / 0.5
        seq = self._rec.run(None, {'x': img.transpose(2, 0, 1)[None, ...]})[0][0]
        idx = seq.argmax(axis=1)
        chars, prev = [], -1
        for i in idx:
            if i != 0 and i != prev:
                chars.append(self._chars[i] if i < len(self._chars) else '')
            prev = i
        return ''.join(chars).strip()


def _resize(a, nw, nh):
    """blinear 缩放（numpy 实现，不引 PIL）。

    字幕条本身很小（一般 600×80 以内），这一步的耗时可以忽略。
    """
    h, w = a.shape[:2]
    if (w, h) == (nw, nh):
        return a
    ys = (np.arange(nh, dtype=np.float32) + 0.5) * (h / float(nh)) - 0.5
    xs = (np.arange(nw, dtype=np.float32) + 0.5) * (w / float(nw)) - 0.5
    ys = np.clip(ys, 0, h - 1)
    xs = np.clip(xs, 0, w - 1)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None, None]
    wx = (xs - x0)[None, :, None]
    a = a.astype(np.float32)
    top = a[y0][:, x0] * (1 - wx) + a[y0][:, x1] * wx
    bottom = a[y1][:, x0] * (1 - wx) + a[y1][:, x1] * wx
    return (top * (1 - wy) + bottom * wy).astype(np.uint8)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    reader = Reader(model_dir)
    try:
        reader.start()
    except Exception as err:
        emit({'ok': False, 'ready': False, 'error': '模型加载失败: %s' % err})
        return 1
    emit({'ok': True, 'ready': True, 'det': DET_FILE, 'rec': REC_FILE})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as err:
            emit({'ok': False, 'error': '请求不是 JSON: %s' % err})
            continue
        cmd = req.get('cmd') or 'read'
        if cmd == 'quit':
            break
        if cmd == 'ping':
            emit({'ok': True, 'ready': True})
            continue
        if cmd != 'read':
            emit({'ok': False, 'error': '不认识的命令: %s' % cmd})
            continue
        t0 = time.time()
        try:
            w = int(req.get('w') or 0)
            h = int(req.get('h') or 0)
            if w < 8 or h < 8:
                emit({'ok': False, 'error': '尺寸太小: %dx%d' % (w, h)})
                continue
            if req.get('bgra'):
                buf = base64.b64decode(req.get('bgra'))
                if len(buf) != w * h * 4:
                    emit({'ok': False, 'error': '像素长度不对: %d != %d' % (len(buf), w * h * 4)})
                    continue
                # BGRA → RGB：丢掉 alpha，再反一下通道顺序
                arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)[:, :, 2::-1]
            else:
                buf = base64.b64decode(req.get('rgb') or '')
                if len(buf) != w * h * 3:
                    emit({'ok': False, 'error': '像素长度不对: %d != %d' % (len(buf), w * h * 3)})
                    continue
                arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
            text, lines = reader.read(arr, w, h)
            emit({'ok': True, 'text': text, 'lines': lines, 'ms': int((time.time() - t0) * 1000)})
        except Exception as err:
            emit({'ok': False, 'error': '识别出错: %s' % err})
    return 0


if __name__ == '__main__':
    sys.exit(main())
