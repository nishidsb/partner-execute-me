#!/usr/bin/env python3
"""G1A（Gust 官方骨骼动画）-> 采样成 glTF 动画帧数据（JSON）

格式认知（依据 Joschuka/fmt_g1m 的 GPL 实现所揭示的格式布局自行实现，未拷代码）：
  头 40 字节：magic "G1A_"(LE u32) + version "2400" + filesize + type(u16) +
              unk(u16) + duration(f32) + quantSectionOff(u32, *0x10) + 6*u32 保留
  骨骼表：boneInfoCount 个 (boneID u32, splineInfoOff u32(*0x10, 相对骨骼表起点))
  样条：opcode u32（1=2ch 2=4ch旋转 4=7ch旋转+平移 6=10ch缩放+旋转+平移 8=7ch缩放+旋转）
        每通道 8 字节 (keyCount u32, dataOff u32(*0x10, 相对样条起点))
        数据 = keyCount * [a,b,c,d f32] + keyCount * [time f32]
  求值：查询时间 t 落在段 [t0,t1]（段 i 的终点是 times[i]），r=(t-t0)/(t1-t0)，
        value = a*r^3 + b*r^2 + c*r + d；段起点值=d，段终点值=a+b+c+d（连续性）。

坐标系：g1m_to_basic_gltf 写 rest pose 用 g1m 原始四元数(x,y,z,w)不共轭（已验证成品 VRM 正确），
  所以动画四元数同样直接用原始值；fmt_g1m 的 transpose() 是 Noesis 约定，glTF 不需要。
  是否真的如此用 --probe 对比 rest 实测（见 main）。

用法：
  python tools/g1a2gltf.py <g1a 文件> <Oid.bin> <模型.gltf> <输出.json> [--fps 30] [--probe]
输出 JSON：{"name","duration","fps","bones":{节点名:{"times":[],"rot":[[x,y,z,w]...],"trans":[[x,y,z]...],"scale":[[x,y,z]...]}}}
"""
import json
import struct
import sys

import numpy as np


def parse_oid(path):
    """Oid.bin：[len][str] 序列，str 形如 '索引,骨骼名'。返回 {boneID: name}"""
    d = open(path, 'rb').read()
    bones = {}
    i = 0
    while i < len(d):
        n = d[i]
        i += 1
        s = d[i:i + n].decode('ascii', errors='replace')
        i += n
        if ',' in s:
            idx, _, name = s.partition(',')
            if idx.isdigit():
                bones[int(idx)] = name
    return bones


def parse_g1a(path):
    """解析 g1a，返回 {duration, bones: {boneID: {'rot': (segs...), 'pos': ..., 'scale': ...}}}
    每个通道是 [(coef(4f), time)] 列表（段定义：coef 作用于 [prev_time, time]）"""
    d = open(path, 'rb').read()
    magic, version = d[:4], d[4:8]
    if magic != b'_A1G':
        raise ValueError('not a g1a: magic=%r' % magic)
    (filesize, anim_type, unk, duration, quant_off) = struct.unpack_from('<IHHfI', d, 8)
    head = 48  # 8 魔数版本 + 4 size + 2+2 type/unk + 4 dur + 4 quantOff + 6*4 保留
    bone_count, bone_max = struct.unpack_from('<HH', d, head)
    bones = {}
    for i in range(bone_count):
        # bone_count/bone_max 占 48..52，骨骼表从 52 开始；样条偏移相对 48
        bone_id, spline_off = struct.unpack_from('<II', d, head + 4 + i * 8)
        sp = head + spline_off * 0x10
        opcode, = struct.unpack_from('<I', d, sp)
        nch = {1: 2, 2: 4, 4: 7, 6: 10, 8: 7}.get(opcode)
        if nch is None:
            raise ValueError('unknown opcode %#x bone %d' % (opcode, bone_id))
        chans = []
        for j in range(nch):
            kcount, data_off = struct.unpack_from('<II', d, sp + 4 + j * 8)
            base = sp + data_off * 0x10
            coefs = np.frombuffer(d, dtype='<f4', count=kcount * 4, offset=base).reshape(kcount, 4)
            times = np.frombuffer(d, dtype='<f4', count=kcount, offset=base + kcount * 16)
            chans.append((coefs.astype(np.float64), times.astype(np.float64)))
        entry = bones.setdefault(bone_id, {})
        if opcode in (2, 4, 6):
            entry['rot'] = chans[0:4]
        if opcode in (4, 6):  # 4: rot+pos -> pos 在 4..6；6: scale+rot+pos -> pos 在 7..9
            entry['pos'] = chans[4:7] if opcode == 4 else chans[7:10]
        if opcode in (6, 8):
            entry['scale'] = chans[0:3]
    return {'duration': float(duration), 'type': anim_type, 'bones': bones}


def eval_channel(chans, t):
    """一组通道（每通道是 cubic 段列表）在时间 t 的值。fmt_g1m 的段选择逻辑：
    找第一个 t < time 的 key，用该段（段起点 = 前一 key 时间或 0）；找不到用最后一段。
    t=0 且首 key=0 的边界：落到第二段 r=0，值=第二段起点=首段终点=首 key 值，自洽。"""
    out = []
    for coefs, times in chans:
        idx = len(times) - 1
        for k, t1 in enumerate(times):
            if t < t1:
                idx = k
                break
        t1 = times[idx]
        t0 = times[idx - 1] if idx > 0 else 0.0
        span = t1 - t0
        r = 0.0 if span <= 1e-9 else (t - t0) / span
        a, b, c, dd = coefs[idx]
        out.append(float(a * r ** 3 + b * r ** 2 + c * r + dd))
    return out


def quat_norm(q):
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q)
    if n < 1e-9:
        return [0.0, 0.0, 0.0, 1.0]
    return (q / n).tolist()


def sample_anim(g1a, fps):
    """均匀采样到 fps。返回 {boneID: {'times','rot','trans','scale'}}"""
    dur = g1a['duration']
    n = max(2, int(round(dur * fps)) + 1)
    times = [i * dur / (n - 1) for i in range(n)]
    out = {}
    for bid, ch in g1a['bones'].items():
        e = {}
        if 'rot' in ch:
            e['rot'] = [quat_norm(eval_channel(ch['rot'], t)) for t in times]
        if 'pos' in ch:
            e['trans'] = [eval_channel(ch['pos'], t) for t in times]
        if 'scale' in ch:
            e['scale'] = [eval_channel(ch['scale'], t) for t in times]
        if e:
            e['times'] = times
            out[bid] = e
    return out


def load_gltf_rotations(path):
    """读 glTF 节点 rest rotation（按名字），用于 --probe 对比坐标系约定。"""
    g = json.load(open(path, encoding='utf-8'))
    rots = {}
    for nd in g.get('nodes', []):
        if 'name' in nd and 'rotation' in nd:
            rots[nd['name']] = nd['rotation']
    return rots


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = set(a[2:] for a in sys.argv[1:] if a.startswith('--') and '=' not in a[2:])
    fps = 30
    for a in sys.argv[1:]:
        if a.startswith('--fps='):
            fps = float(a.split('=')[1])
    g1a_path, oid_path, gltf_path, out_path = args[0], args[1], args[2], args[3]

    g1a = parse_g1a(g1a_path)
    oid = parse_oid(oid_path)
    sampled = sample_anim(g1a, fps)

    anim_name = g1a_path.replace('\\', '/').rsplit('/', 1)[-1].rsplit('.', 1)[0].lower()
    result = {'name': anim_name, 'duration': g1a['duration'], 'fps': fps, 'bones': {}}
    unmapped = []
    for bid, e in sorted(sampled.items()):
        name = oid.get(bid)
        if not name:
            unmapped.append(bid)
            continue
        result['bones'][name] = e

    if 'probe' in flags:
        rest = load_gltf_rotations(gltf_path)
        for bone in ('SK_Hips', 'SK_L_Arm', 'SK_Head', 'SK_L_Leg'):
            e = sampled.get([k for k, v in oid.items() if v == bone][0]) if bone in oid.values() else None
            if not e:
                print('%-14s 动画无此骨骼' % bone)
                continue
            r0 = e['rot'][0]
            r_rest = rest.get(bone)
            if not r_rest:
                print('%-14s glTF 无 rest' % bone)
                continue
            d_raw = np.dot(r0, r_rest)                # 同向程度（1=完全一致）
            d_conj = np.dot(r0, [-x for x in r_rest[:3]] + [r_rest[3]])  # 共轭后的同向程度
            print('%-14s anim[0]=%s rest=%s  |dot|原始=%.4f 共轭=%.4f' % (
                bone, [round(x, 4) for x in r0], [round(x, 4) for x in r_rest], abs(d_raw), abs(d_conj)))

    json.dump(result, open(out_path, 'w', encoding='utf-8'))
    print('%s: %d 骨骼（未映射 %d），时长 %.2fs，%d 帧 -> %s' % (
        anim_name, len(result['bones']), len(unmapped), g1a['duration'], fps, out_path))
    if unmapped:
        print('未映射 boneID:', unmapped[:20])


if __name__ == '__main__':
    main()
