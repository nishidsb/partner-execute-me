#!/usr/bin/env python3
"""g1a 全量转 VRM 动画（官方样条精确求值 + 容差抽稀 -> LINEAR 关键帧）

流程：
  1. parse_g1a 得到每骨骼每分量的三次样条段序列（官方原始数据，稠密关键帧）
  2. 每分量在稠密网格上精确求值（段端点 + 段内细分）
  3. 1D Douglas-Peucker 抽稀：以「线性插值误差」为度量，容差
       rotation 0.002（四元数分量，约 0.11°）
       translation 0.0005 m（0.5mm）
       scale 0.001
     —— 桌宠尺寸下肉眼不可见
  4. 各分量保留 key 的时间轴取并集，value 在这些时刻按原始样条精确求值
  5. 四元数 key 归一化 + 相邻 key 点积为负整体取反
  6. 整条恒值且等于 rest 的轨道跳过；root/SK_Skeleton/SK_Hips 水平位移清零
  7. 位移 ×0.01 厘米->米

用法：
  python tools/g1a-bake-all.py <模型.vrm> <输出.vrm> <Oid.bin> <g1a目录> \
      [--alias=idle=gust_00060,walk=gust_00010,run=gust_00021] \
      [--only=gust_00060,...] [--skip=gust_00060,...] [--stats]
"""
import glob
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from g1a2gltf import parse_g1a, parse_oid

ZERO_XZ = ('root', 'SK_Skeleton', 'SK_Hips')
EPS = {'rotation': 0.004, 'translation': 0.001, 'scale': 0.002}
SUBDIV = 8          # 每段细分数
STATS = {'keys_raw': 0, 'keys_out': 0, 'tracks': 0, 'tracks_dropped': 0}


def pad4(b, fill=b'\x00'):
    r = len(b) % 4
    return b + fill * (4 - r) if r else b


def dense_eval(coefs, times, duration, subdiv=SUBDIV):
    """稠密网格求值。返回 (ts, vs)：ts 含全部段端点与段内细分点。"""
    ts, vs = [], []
    for i in range(len(times)):
        t1 = float(times[i])
        t0 = ts[-1] if ts else 0.0
        span = t1 - t0
        n = max(1, subdiv)
        for j in range(n):
            r = j / n
            t = t0 + span * r
            a, b, c, d = coefs[i]
            ts.append(t)
            vs.append(a * r ** 3 + b * r ** 2 + c * r + d)
    # 末尾补 duration hold 点
    if duration > ts[-1] + 1e-4:
        ts.append(float(duration))
        a, b, c, d = coefs[-1]
        vs.append(a + b + c + d)
    return ts, vs


def rdp_1d(ts, vs, eps):
    """以线性插值误差为度量的 Douglas-Peucker。返回保留索引（含首尾）。"""
    n = len(ts)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 - i0 < 2:
            continue
        t0, v0 = ts[i0], vs[i0]
        t1, v1 = ts[i1], vs[i1]
        slope = (v1 - v0) / (t1 - t0) if t1 > t0 else 0.0
        best_i, best_e = -1, eps
        for i in range(i0 + 1, i1):
            e = abs(v0 + slope * (ts[i] - t0) - vs[i])
            if e > best_e:
                best_e, best_i = e, i
        if best_i > 0:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [i for i in range(n) if keep[i]]


def simplify_channel(coefs, times, duration, kind):
    """单分量样条 -> (times[], values[])（原始单位，未缩放）。"""
    ts, vs = dense_eval(coefs, times, duration)
    STATS['keys_raw'] += len(ts)
    idx = rdp_1d(ts, vs, EPS[kind])
    STATS['keys_out'] += len(idx)
    return [ts[i] for i in idx], [vs[i] for i in idx]


def rdp_vec(ts, vs, eps):
    """向量轨道联合 Douglas-Peucker：任一分量线性插值误差 > eps 就保留该点。
    vs: [n][ncomp]。返回保留索引（含首尾）。"""
    n = len(ts)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 - i0 < 2:
            continue
        t0, t1 = ts[i0], ts[i1]
        v0, v1 = vs[i0], vs[i1]
        slope = [(v1[c] - v0[c]) / (t1 - t0) for c in range(len(v0))] if t1 > t0 else [0.0] * len(v0)
        best_i, best_e = -1, eps
        for i in range(i0 + 1, i1):
            e = 0.0
            vi = vs[i]
            for c in range(len(v0)):
                d = abs(v0[c] + slope[c] * (ts[i] - t0) - vi[c])
                if d > e:
                    e = d
            if e > best_e:
                best_e, best_i = e, i
        if best_i > 0:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [i for i in range(n) if keep[i]]


def eval_at(coefs, times, t):
    """原始样条在 t 处的精确值（段端点处取段边界值，连续所以无歧义）。"""
    idx = len(times) - 1
    for k, t1 in enumerate(times):
        if t < t1 - 1e-9:
            idx = k
            break
    t1 = float(times[idx])
    t0 = float(times[idx - 1]) if idx > 0 else 0.0
    span = t1 - t0
    r = 0.0 if span <= 1e-9 else min(max((t - t0) / span, 0.0), 1.0)
    a, b, c, d = coefs[idx]
    return float(a * r ** 3 + b * r ** 2 + c * r + d)


def is_const_ch(coefs):
    return bool(np.max(np.abs(np.asarray(coefs)[:, :3])) < 1e-7) and \
        float(coefs[0][3]) == float(coefs[-1][3])


def build_track(chans, duration, kind, rest_v):
    """chans: 每分量 (coefs, times)。返回 {'times','values'} 或 None。"""
    ncomp = len(chans)
    # 全恒值：等于 rest 就整条跳过，否则 2 个 key
    if all(is_const_ch(c) for c, _ in chans):
        vals = [float(c[0][3]) for c, _ in chans]
        if rest_v is not None and all(abs(v - rv) < 1e-5 for v, rv in zip(vals, rest_v)):
            STATS['tracks_dropped'] += 1
            return None
        return {'times': [0.0, float(duration)], 'values': [vals, vals]}

    # 合并各分量的稠密时间网格（段端点 + 段内细分），再单调扫描精确求值
    tset = set()
    for c, t in chans:
        ts, _ = dense_eval(c, t, duration)
        STATS['keys_raw'] += len(ts)
        tset.update(round(x, 6) for x in ts)
    grid_ts = sorted(tset)
    grid_vs = []
    for c, t in chans:
        segs = c
        nseg = len(t)
        pos = 0  # 当前段指针（grid_ts 单调递增）
        vals = []
        for gt in grid_ts:
            while pos < nseg - 1 and gt >= float(t[pos]) - 1e-9:
                pos += 1
            t1 = float(t[pos])
            t0 = float(t[pos - 1]) if pos > 0 else 0.0
            span = t1 - t0
            r = 0.0 if span <= 1e-9 else min(max((gt - t0) / span, 0.0), 1.0)
            a, b, cc, dd = segs[pos]
            vals.append(a * r ** 3 + b * r ** 2 + cc * r + dd)
        grid_vs.append(vals)
    # 列优先组装成 [n][ncomp]
    grid_vs = [[grid_vs[c][i] for c in range(len(chans))] for i in range(len(grid_ts))]
    idx = rdp_vec(grid_ts, grid_vs, EPS[kind])
    STATS['keys_out'] += len(idx)
    STATS['tracks'] += 1
    return {'times': [grid_ts[i] for i in idx],
            'values': [grid_vs[i] for i in idx]}


def post_quat(track):
    """四元数轨道：归一化 + 相邻 key 符号连续。"""
    prev = None
    for i in range(len(track['times'])):
        q = np.asarray(track['values'][i], dtype=np.float64)
        q = q / max(float(np.linalg.norm(q)), 1e-9)
        if prev is not None and float(np.dot(q, prev)) < 0:
            q = -q
        track['values'][i] = [float(x) for x in q]
        prev = q
    return track


def g1a_to_tracks(g1a, oid, nodes_by_name):
    dur = g1a['duration']
    out = {}
    for bid, ch in g1a['bones'].items():
        name = oid.get(bid)
        if not name:
            continue
        node = nodes_by_name.get(name)
        rest = node or {}
        tr = {}
        if 'rot' in ch:
            t = build_track([ch['rot'][k] for k in range(4)], dur, 'rotation',
                            rest.get('rotation'))
            if t:
                tr['rotation'] = post_quat(t)
        if 'pos' in ch:
            chans = []
            for k in range(3):
                c, tt = ch['pos'][k]
                if name in ZERO_XZ and k != 1:
                    c = np.asarray(c, dtype=np.float64).copy()
                    c[:, :3] = 0.0  # x/z 系数清零 -> 恒 0（d 也清）
                    c[:, 3] = 0.0
                chans.append((c, tt))
            t = build_track(chans, dur, 'translation', rest.get('translation'))
            if t:
                for row in t['values']:
                    for k in range(3):
                        if name in ZERO_XZ and k != 1:
                            row[k] = 0.0
                        else:
                            row[k] *= 0.01  # cm -> m
                tr['translation'] = t
        if 'scale' in ch:
            t = build_track([ch['scale'][k] for k in range(3)], dur, 'scale',
                            rest.get('scale'))
            if t:
                tr['scale'] = t
        if tr:
            out[name] = tr
    return out


def main():
    args = sys.argv[1:]
    if len(args) < 4:
        print(__doc__)
        return 1
    vrm_path, out_path, oid_path, g1a_dir = args[0], args[1], args[2], args[3]
    only, skip, alias = set(), set(), {}
    for a in args:
        if a.startswith('--only='):
            only = set(a.split('=', 1)[1].split(','))
        elif a.startswith('--skip='):
            skip = set(a.split('=', 1)[1].split(','))
        elif a.startswith('--alias='):
            for pair in a.split('=', 1)[1].split(','):
                k, _, v = pair.partition('=')
                if k and v:
                    alias[k] = v

    d = open(vrm_path, 'rb').read()
    magic, ver, total = struct.unpack_from('<4sII', d, 0)
    assert magic == b'glTF', 'not a GLB'
    clen, ctype = struct.unpack_from('<II', d, 12)
    g = json.loads(d[20:20 + clen])
    bin_off = 20 + clen
    blen, btype = struct.unpack_from('<II', d, bin_off)
    bin_data = bytearray(d[bin_off + 8:bin_off + 8 + blen])

    def add_bv(data):
        while len(bin_data) % 4:
            bin_data.append(0)
        off = len(bin_data)
        bin_data.extend(data)
        g.setdefault('bufferViews', []).append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data)})
        return len(g['bufferViews']) - 1

    def add_acc(flat, comp_type, count):
        data = struct.pack('<%df' % len(flat), *flat)
        bv = add_bv(data)
        g.setdefault('accessors', []).append({
            'bufferView': bv, 'componentType': 5126, 'count': count,
            'type': comp_type})
        return len(g['accessors']) - 1

    nodes_by_name = {n.get('name'): n for n in g.get('nodes', [])}
    node_index = {n.get('name'): i for i, n in enumerate(g.get('nodes', []))}
    oid = parse_oid(oid_path)

    files = sorted(glob.glob(os.path.join(g1a_dir, 'pc20a_*', 'PC20A_*.g1a')))
    print('g1a 文件:', len(files))

    g.setdefault('animations', [])
    baked = skipn = 0

    def bake(cname, tracks):
        nonlocal baked
        samplers, channels = [], []
        for bone, tr in tracks.items():
            ni = node_index.get(bone)
            if ni is None:
                continue
            for path in ('rotation', 'translation', 'scale'):
                t = tr.get(path)
                if not t:
                    continue
                ncomp = {'rotation': 4, 'translation': 3, 'scale': 3}[path]
                in_acc = add_acc(t['times'], 'SCALAR', len(t['times']))
                flat = [v for row in t['values'] for v in row]
                out_acc = add_acc(flat, 'VEC%d' % ncomp, len(t['times']))
                samplers.append({'input': in_acc, 'output': out_acc, 'interpolation': 'LINEAR'})
                channels.append({'sampler': len(samplers) - 1,
                                 'target': {'node': ni, 'path': path}})
        if channels:
            g['animations'].append({'name': cname, 'samplers': samplers, 'channels': channels})
            baked += 1

    cache = {}
    for f in files:
        cname = 'gust_' + os.path.basename(f).split('_')[1].split('.')[0]
        if (only and cname not in only) or cname in skip:
            skipn += 1
            continue
        try:
            g1a = parse_g1a(f)
        except Exception as e:
            print('  解析失败', cname, e)
            skipn += 1
            continue
        cache[cname] = g1a_to_tracks(g1a, oid, nodes_by_name)

    for cname in sorted(cache):
        bake(cname, cache[cname])
    for alias_name, src in alias.items():
        if src in cache:
            bake(alias_name, cache[src])

    if '--stats' in args:
        print('抽稀统计: 原始 key %d -> 输出 key %d (%.1f%%)，轨道 %d，跳过恒值轨道 %d' % (
            STATS['keys_raw'], STATS['keys_out'],
            100.0 * STATS['keys_out'] / max(1, STATS['keys_raw']),
            STATS['tracks'], STATS['tracks_dropped']))

    g['buffers'][0]['byteLength'] = len(bin_data)
    js = json.dumps(g, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    js = pad4(js, b' ')
    bin_data = pad4(bytes(bin_data))
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(bin_data))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
    open(out_path, 'wb').write(out)
    print('烘入 %d 个 clip（跳过 %d）-> %s (%.1f MB)' % (baked, skipn, out_path, len(out) / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main())
