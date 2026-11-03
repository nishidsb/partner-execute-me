#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VRMA 待机动作离线体检（不参与应用运行）· 0.45.86

用户 11-01 反馈：有个动作会抽搐、有个动作左右手明显反了。
本脚本对 motions/*.vrma 逐个量化：
  1. 帧间角速度尖峰（抽搐 = 相邻关键帧之间夹角突跳，远超前后文）；
  2. 上臂姿态统计（平均离垂线角 / 方位角）——离线数字只做诊断，
     修不修、怎么修以渲染层闭环为准（0.45.80 两次翻车的教训）。

用法: python tools/inspect-vrma.py <motions 目录> [尖峰阈值度/帧，默认 12]
"""
import struct, json, math, sys, io, os, glob

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BONES = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']


def load_gltf(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'glTF'
    jlen = struct.unpack('<I', data[12:16])[0]
    g = json.loads(data[20:20 + jlen])
    bin_len = struct.unpack('<I', data[20 + jlen:24 + jlen])[0]
    bin_data = data[20 + jlen + 8:20 + jlen + 8 + bin_len]
    return g, bin_data


def read_accessor(g, bin_data, idx):
    a = g['accessors'][idx]
    comp = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4)}[a['componentType']]
    ncomp = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    view = g['bufferViews'][a['bufferView']]
    base = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = view.get('byteStride') or comp[1] * ncomp
    fmt = '<' + comp[0] * ncomp
    return [struct.unpack_from(fmt, bin_data, base + i * stride) for i in range(a['count'])]


def qangle(q1, q2):
    d = abs(sum(a * b for a, b in zip(q1, q2)))
    d = min(1.0, max(-1.0, d))
    return math.degrees(2 * math.acos(d))


def quat_deg(q):
    w, x, y, z = q
    return math.degrees(2 * math.acos(min(1.0, abs(w))))


def analyze(path, spike_deg):
    g, bin_data = load_gltf(path)
    ext = g['extensions']['VRMC_vrm_animation']
    hum = ext['humanoid']['humanBones']
    node2bone = {m['node']: k for k, m in hum.items()}
    anim = g['animations'][0]
    out = {'file': os.path.basename(path), 'bones': {}}
    for ch in anim['channels']:
        tgt = ch['target']['node']
        bone = node2bone.get(tgt)
        if not bone or bone not in BONES or ch['target'].get('path') != 'rotation':
            continue
        s = anim['samplers'][ch['sampler'] if isinstance(ch['sampler'], int) else 0]
        times = [t[0] for t in read_accessor(g, bin_data, s['input'])]
        quats = read_accessor(g, bin_data, s['output'])
        n = len(quats)
        spikes = []
        steps = []
        for i in range(1, n):
            d = qangle(quats[i - 1], quats[i])
            dt = times[i] - times[i - 1]
            steps.append(d)
            if d >= spike_deg:
                spikes.append((round(times[i], 2), round(d, 1), round(d / max(dt, 1e-6))))
        # 前后文基线：去掉最大 5% 后的均值（真正的动作速度）
        base = sorted(steps)
        k = max(0, int(len(base) * 0.95) - 1)
        baseline = sum(base[:k + 1]) / max(1, len(base[:k + 1]))
        out['bones'][bone] = {
            'keys': n, 'dur': round(times[-1] - times[0], 2) if n > 1 else 0,
            'max_step': round(max(steps), 1) if steps else 0,
            'baseline': round(baseline, 1),
            'spikes': sorted(spikes, key=lambda x: -x[1])[:5],
        }
    return out


def main():
    d = sys.argv[1]
    spike = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
    for p in sorted(glob.glob(os.path.join(d, '*.vrma'))):
        try:
            r = analyze(p, spike)
        except Exception as e:
            print(os.path.basename(p), '解析失败:', e)
            continue
        print('== ' + r['file'])
        for b, st in sorted(r['bones'].items()):
            flag = ''
            # 尖峰 = 单帧跳变同时远超基线（>6 倍）且绝对值大（>spike°）
            if st['spikes'] and st['max_step'] > max(spike, st['baseline'] * 6):
                flag = ' ★尖峰'
            print('  %-16s keys=%-4d dur=%-5s 最大帧间=%-6s 基线=%-6s%s' %
                  (b, st['keys'], st['dur'], st['max_step'], st['baseline'], flag))
            for t, dstep, dps in st['spikes'][:3]:
                print('      @%.2fs %s°（%s°/s）' % (t, dstep, dps))


if __name__ == '__main__':
    main()
