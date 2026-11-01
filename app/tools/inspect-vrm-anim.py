#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""0.45.80 待机手臂自然化 · 离线校准工具（不参与应用运行）

解析 VRM（glb）里烘入的动画，计算 humanoid 上臂在「绑定姿势 / 各 idle clip」
关键帧下的世界方向与「离垂直下垂角」（0°=笔直下垂，90°=水平 T-pose），
并搜索把 idle_still 姿态收到目标角度的局部欧拉修正（渲染层 premultiply 用）。

用法: python tools/inspect-vrm-anim.py <model.vrm> [目标角度]

背景：本模型（ryza2-ryza.vrm）绑定姿势上臂离垂线 51°，烘入的 idle_still
更外张（L 60.6° / R 66.4°）——mixer 模式下官方 clip 每帧写绝对值、改不了
clip 本体。渲染层（vrm-stage.js 0.45.81 起）用「运行时自校正」：每帧量上臂
世界方向、setFromUnitVectors 转向仰角 12° 的目标方向（注意：按本脚本离线
求出的局部欧拉修正在渲染器里方向相反——VRM 祖先节点带 matrix，离线换算
不可靠，别再走这条路）。本脚本保留作诊断用途。换模型后重跑看新模型的
绑定/待机手臂角度。
"""
import struct, json, math, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')


def load_gltf(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'glTF'
    jlen = struct.unpack('<I', data[12:16])[0]
    g = json.loads(data[20:20 + jlen])
    bin_len = struct.unpack('<I', data[20 + jlen:24 + jlen])[0]
    bin_data = data[20 + jlen + 8:20 + jlen + 8 + bin_len]
    return g, bin_data


def main():
    path = sys.argv[1]
    target = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
    g, bin_data = load_gltf(path)
    nodes = g['nodes']
    acc, bv = g['accessors'], g['bufferViews']

    def read_accessor(idx):
        a = acc[idx]
        comp = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4)}[a['componentType']]
        ncomp = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
        off = a.get('byteOffset', 0)
        view = bv[a['bufferView']]
        base = view.get('byteOffset', 0)
        stride = view.get('byteStride') or comp[1] * ncomp
        return [struct.unpack_from('<' + comp[0] * ncomp, bin_data, base + off + i * stride)
                for i in range(a['count'])]

    # humanoid 映射（VRM 1.0: extensions.VRMC_vrm.humanoid.humanBones）
    ext = g.get('extensions', {}).get('VRMC_vrm') or g.get('extensions', {}).get('VRM')
    hb = ext['humanoid']['humanBones']
    arm = {}
    for bone, m in hb.items():
        if bone in ('leftUpperArm', 'rightUpperArm'):
            arm[bone] = m['node']
    print('humanoid 上臂节点:', {k: (v, nodes[v].get('name')) for k, v in arm.items()})

    # 父链
    scene_roots = g['scenes'][g.get('scene', 0)]['nodes']
    parent = {}
    stack = list(scene_roots)
    while stack:
        n = stack.pop()
        for c in nodes[n].get('children', []):
            parent[c] = n
            stack.append(c)

    def qmul(a, b):
        ax, ay, az, aw = a; bx, by, bz, bw = b
        return (aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
                aw * bw - ax * bx - ay * by - az * bz)

    def qrot(q, v):
        x, y, z, w = q; vx, vy, vz = v
        tx = 2 * (y * vz - z * vy); ty = 2 * (z * vx - x * vz); tz = 2 * (x * vy - y * vx)
        return (vx + w * tx + (y * tz - z * ty),
                vy + w * ty + (z * tx - x * tz),
                vz + w * tz + (x * ty - y * tx))

    def local_rot(i):
        return tuple(nodes[i].get('rotation', [0, 0, 0, 1]))

    def world_rot(i, ov=None):
        chain = []; j = i
        while j is not None:
            chain.append(j); j = parent.get(j)
        q = (0, 0, 0, 1)
        for k in reversed(chain):
            q = qmul(q, (ov or {}).get(k, local_rot(k)))
        return q

    def bone_dir(idx, ov=None):
        q = world_rot(idx, ov)
        n = nodes[idx]
        child = next((c for c in n.get('children', [])
                      if 'ForeArm' in (nodes[c].get('name') or '')), None)
        d = tuple(nodes[child].get('translation', [0, 0, 0])[k] -
                  n.get('translation', [0, 0, 0])[k] for k in range(3))
        return qrot(q, d)

    def droop(v):
        L = math.sqrt(sum(x * x for x in v))
        return math.degrees(math.asin(abs(v[1]) / L))

    print('rest(绑定): L=%.1f° R=%.1f°' % (droop(bone_dir(arm['leftUpperArm'])),
                                           droop(bone_dir(arm['rightUpperArm']))))

    # IDLE_RE 语义：名字含 idle/stand/wait/... 的第一个 clip
    import re
    idle_re = re.compile(r'idle|stand|wait|breath|loop|待机|呼吸|静止', re.I)
    clip = next(a for a in g['animations'] if idle_re.search(a.get('name', '')))
    print('官方 idle clip:', clip.get('name'))
    base_ov = {}
    for ch in clip['channels']:
        ni = ch['target']['node']
        if ch['target'].get('path') == 'rotation' and ni in arm.values():
            base_ov[ni] = read_accessor(clip['samplers'][ch['sampler']]['output'])[0]
    print('idle 关键帧0: L=%.1f° R=%.1f°' % (droop(bone_dir(arm['leftUpperArm'], base_ov)),
                                             droop(bone_dir(arm['rightUpperArm'], base_ov))))

    def axis_q(axis, deg):
        r = math.radians(deg) / 2; s = math.sin(r)
        return {'x': (s, 0, 0, math.cos(r)), 'y': (0, s, 0, math.cos(r)),
                'z': (0, 0, s, math.cos(r))}[axis]

    def qnorm(q):
        l = math.sqrt(sum(c * c for c in q))
        return tuple(c / l for c in q)

    for side, key in (('L', 'leftUpperArm'), ('R', 'rightUpperArm')):
        idx = arm[key]
        results = []
        for dx in range(-80, 81, 5):
            for dy in range(-40, 41, 5):
                for dz in range(-80, 81, 5):
                    dq = qnorm(qmul(qmul(axis_q('x', dx), axis_q('y', dy)), axis_q('z', dz)))
                    ov = dict(base_ov); ov[idx] = qnorm(qmul(dq, base_ov[idx]))
                    d = droop(bone_dir(idx, ov))
                    results.append((abs(d - target), d, dx, dy, dz))
        results.sort()
        _, d, dx, dy, dz = results[0]
        print(f'{side}: 修正 x={dx}° y={dy}° z={dz}° → droop={d:.1f}°')


if __name__ == '__main__':
    main()
