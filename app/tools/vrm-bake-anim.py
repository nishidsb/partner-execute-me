#!/usr/bin/env python3
"""把 g1a2gltf.py 采样的动画 JSON 烘进 VRM（GLB）的 animations

- clip 名用 --name= 指定（播放端按 /idle|stand|wait/ 与 /walk|run/ 正则识别 idle/walk）
- 位移单位厘米 -> 米（与 gust2vrm 一致 ×0.01），hips/root/Skeleton 的水平分量清零（原地走，
  桌宠位置由主进程控制，动画自带的世界位移会把角色挪走）
- 只在 root 的直接骨骼（名字匹配的 SK_* / root / SK_Skeleton）上写通道；手指等蒙皮细节
  动画也一起烘（目标节点按名字查找，找不到就跳过并计数）

用法：
  python tools/vrm-bake-anim.py <模型.vrm> <输出.vrm> <anim.json> [--name=idle] [anim2.json --name=walk ...]
"""
import json
import struct
import sys


def pad4(b, fill=b'\x00'):
    r = len(b) % 4
    return b + fill * (4 - r) if r else b


def find_node(g, name):
    for i, n in enumerate(g.get('nodes', [])):
        if n.get('name') == name:
            return i
    return -1


ZERO_XZ = ('root', 'SK_Skeleton', 'SK_Hips')  # 世界位移不上身（原地表演）


def bake_anim(g, anim_json, clip_name):
    bones = anim_json['bones']
    samplers = []
    channels = []
    # 直接把 float 数组拍平进 bin；bufferView 追加式管理
    skipped = []
    for bone, e in bones.items():
        node = find_node(g, bone)
        if node < 0:
            skipped.append(bone)
            continue
        times = e['times']
        paths = []
        if 'rot' in e:
            paths.append(('rotation', e['rot'], 4))
        if 'trans' in e:
            tv = []
            for p in e['trans']:
                x, y, z = p[0] * 0.01, p[1] * 0.01, p[2] * 0.01
                if bone in ZERO_XZ:
                    x, z = 0.0, 0.0
                tv.append([x, y, z])
            paths.append(('translation', tv, 3))
        for path, values, ncomp in paths:
            in_bv = {'buffer': 0, 'byteOffset': 0, 'byteLength': 0}  # 由调用方填充
            samplers.append({'input': None, 'output': None})  # 占位，下方重写
            s_idx = len(samplers) - 1
            channels.append({'sampler': s_idx, 'target': {'node': node, 'path': path}})
            # 打包到 pending，统一追加 bin
            samplers[s_idx]['_times'] = times
            samplers[s_idx]['_values'] = values
            samplers[s_idx]['_ncomp'] = ncomp
            samplers[s_idx]['_channel'] = len(channels) - 1
    return samplers, channels, skipped


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        return 1
    vrm_path, out_path = args[0], args[1]
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

    def add_acc(data, comp_type, count, ncomp):
        import struct as _s
        flat = _s.pack('<%df' % (len(data)), *data)
        bv = add_bv(flat)
        g.setdefault('accessors', []).append({
            'bufferView': bv, 'componentType': 5126, 'count': count,
            'type': comp_type, 'min': [min(data)] * ncomp if data else [0] * ncomp,
            'max': [max(data)] * ncomp if data else [0] * ncomp})
        return len(g['accessors']) - 1

    g.setdefault('animations', [])
    clips = []
    i = 2
    while i < len(args):
        aj_path = args[i]
        clip_name = None
        for a in args[i + 1:i + 3]:
            if a.startswith('--name='):
                clip_name = a.split('=', 1)[1]
                break
        aj = json.load(open(aj_path, encoding='utf-8'))
        name = clip_name or aj['name']
        samplers, channels, skipped = bake_anim(g, aj, name)
        # samplers -> accessors
        real_samplers = []
        remap = {}
        for s in samplers:
            times = s['_times']
            vals = [v for row in s['_values'] for v in row]
            in_acc = add_acc(times, 'SCALAR', len(times), 1)
            comp = {4: 'VEC4', 3: 'VEC3'}[s['_ncomp']]
            out_acc = add_acc(vals, comp, len(s['_values']), s['_ncomp'])
            remap[s['_channel']] = len(real_samplers)
            real_samplers.append({'input': in_acc, 'output': out_acc, 'interpolation': 'LINEAR'})
        for ch in channels:
            ch['sampler'] = remap[ch['sampler']]
        g['animations'].append({'name': name, 'samplers': real_samplers, 'channels': channels})
        clips.append('%s(%d 通道)' % (name, len(channels)))
        i += 1 if clip_name is None else 2
        if skipped:
            print('  跳过未找到节点:', skipped[:8])

    g['buffers'][0]['byteLength'] = len(bin_data)
    # 重写 GLB
    js = json.dumps(g, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    js = pad4(js, b' ')
    bin_data = pad4(bytes(bin_data))
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(bin_data))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
    open(out_path, 'wb').write(out)
    print('烘入 %d 个 clip: %s -> %s (%.1f MB)' % (len(clips), ', '.join(clips), out_path, len(out) / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main())
