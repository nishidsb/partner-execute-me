#!/usr/bin/env python3
"""g1m -> glTF（gust_stuff 的 g1m_to_basic_gltf.py 产物）-> 自包含 VRM 1.0

做四件事，都是为了让 Ryza 的 three-vrm 能直接吃：
  1. 贴图：DDS(DXT1/5) -> PNG，塞进 GLB 的 BIN 块（app 导入只拷贝单个文件，外链必丢）
  2. 单位：Gust 用厘米（身高 ~155），全部顶点与骨骼位移 ×0.01 变米（相机 near/far=0.1/50）
  3. 材质：游戏是 toon，PBR 下改成 metallic=0 / roughness=0.86，带 alpha 的走 MASK
  4. 骨架：手写 VRM 1.0 扩展（humanoid 映射 + meta），不依赖 Blender

用法（在 g1m 所在目录执行，那里要有 g1m_to_basic_gltf.py 生成的 .gltf/.bin 和 gust_g1t 解出的 .dds）：
  python tools/gust2vrm.py <目录> <g1m 主名> [输出名]
  例：python tools/gust2vrm.py . PC20A_MODEL_default ryza2-ryza.vrm

实测（《莱莎的炼金工房2》Steam 版 / pc20a）：
  PACK00_02.PAK 2.7G -> gust_pak 5.5G / 6239 项；角色在 data/x64/character/pc20a
  pc20a_model.elixir.gz -> PC20A_MODEL_default.g1m 2.0M -> 23 个子网格 / 38376 面
  产出 VRM 7.5M（贴图 5.3M 内嵌），身高 1.548m，45 根 humanoid
"""
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

# 骨骼名 -> VRM humanoid 名（VRM 1.0 强制要求的 15 根 + 可选的肩膀/脚趾/手指）
BONE_MAP = {
    'SK_Hips': 'hips',
    'SK_Spine01': 'spine',
    'SK_Spine02': 'chest',
    'SK_Neck': 'neck',
    'SK_Head': 'head',
    'SK_L_Shoulder': 'leftShoulder',
    'SK_L_Arm': 'leftUpperArm',
    'SK_L_ForeArm': 'leftLowerArm',
    'SK_L_Hand': 'leftHand',
    'SK_R_Shoulder': 'rightShoulder',
    'SK_R_Arm': 'rightUpperArm',
    'SK_R_ForeArm': 'rightLowerArm',
    'SK_R_Hand': 'rightHand',
    'SK_L_UpLeg': 'leftUpperLeg',
    'SK_L_Leg': 'leftLowerLeg',
    'SK_L_Foot': 'leftFoot',
    'SK_L_Toes': 'leftToes',
    'SK_R_UpLeg': 'rightUpperLeg',
    'SK_R_Leg': 'rightLowerLeg',
    'SK_R_Foot': 'rightFoot',
    'SK_R_Toes': 'rightToes',
}
FINGER_MAP = {
    'Thumb01': ('leftThumbMetacarpal', 'rightThumbMetacarpal'),
    'Thumb02': ('leftThumbProximal', 'rightThumbProximal'),
    'Thumb03': ('leftThumbDistal', 'rightThumbDistal'),
    'Index01': ('leftIndexProximal', 'rightIndexProximal'),
    'Index02': ('leftIndexIntermediate', 'rightIndexIntermediate'),
    'Index03': ('leftIndexDistal', 'rightIndexDistal'),
    'Middle01': ('leftMiddleProximal', 'rightMiddleProximal'),
    'Middle02': ('leftMiddleIntermediate', 'rightMiddleIntermediate'),
    'Middle03': ('leftMiddleDistal', 'rightMiddleDistal'),
    'Ring01': ('leftRingProximal', 'rightRingProximal'),
    'Ring02': ('leftRingIntermediate', 'rightRingIntermediate'),
    'Ring03': ('leftRingDistal', 'rightRingDistal'),
    'Little01': ('leftLittleProximal', 'rightLittleProximal'),
    'Little02': ('leftLittleIntermediate', 'rightLittleIntermediate'),
    'Little03': ('leftLittleDistal', 'rightLittleDistal'),
}
SCALE = 0.01  # 厘米 -> 米


def load_gltf(folder, base):
    path = os.path.join(folder, base + '.gltf')
    with open(path, 'r', encoding='utf-8') as f:
        g = json.load(f)
    bins = []
    for b in g['buffers']:
        uri = b.get('uri', '')
        bins.append(bytearray(open(os.path.join(folder, uri), 'rb').read()) if uri else bytearray())
    return g, bins[0] if bins else bytearray()


def acc_view(g, bin_data, idx):
    """返回 (数组, 是否 float) —— 只处理下面要动的几种 accessor"""
    a = g['accessors'][idx]
    bv = g['bufferViews'][a['bufferView']]
    comp = {5126: ('f4', 4), 5123: ('u2', 2), 5125: ('u4', 4), 5121: ('u1', 1), 5120: ('i1', 1)}[a['componentType']]
    ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or comp[1] * ncomp
    out = np.zeros((a['count'], ncomp), dtype=np.dtype('<' + comp[0]))
    for i in range(a['count']):
        off = start + i * stride
        out[i] = np.frombuffer(bytes(bin_data[off:off + comp[1] * ncomp]), dtype='<' + comp[0])
    return out, comp, ncomp, stride, start


def write_back(bin_data, arr, comp, ncomp, stride, start):
    for i in range(arr.shape[0]):
        off = start + i * stride
        bin_data[off:off + comp[1] * ncomp] = arr[i].tobytes()


def scale_model(g, bin_data):
    """顶点与骨骼位移 ×0.01；accessor 的 min/max 同步改"""
    touched = set()
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            pos = p['attributes'].get('POSITION')
            if pos is None or pos in touched:
                continue
            touched.add(pos)
            arr, comp, ncomp, stride, start = acc_view(g, bin_data, pos)
            arr = (arr.astype(np.float64) * SCALE).astype(arr.dtype)
            write_back(bin_data, arr, comp, ncomp, stride, start)
            a = g['accessors'][pos]
            if 'min' in a:
                a['min'] = [float(v) * SCALE for v in a['min']]
            if 'max' in a:
                a['max'] = [float(v) * SCALE for v in a['max']]
    # 骨骼/节点位移（含 mesh 挂点）；旋转和缩放不动
    for n in g['nodes']:
        if 'translation' in n:
            n['translation'] = [float(v) * SCALE for v in n['translation']]
        if 'matrix' in n:  # 少数导出器给矩阵，整列缩放
            m = list(n['matrix'])
            m[12] = m[12] * SCALE
            m[13] = m[13] * SCALE
            m[14] = m[14] * SCALE
            n['matrix'] = m



def scale_ibm(g, bin_data):
    """蒙皮矩阵的平移列也要 ×0.01。
    顶点和骨骼位移缩了、IBM 不缩的话，boneWorld*IBM 会把网格甩到原点下方（实测 bbox y 掉到 -74）。"""
    done = set()
    for skin in g.get('skins', []):
        idx = skin.get('inverseBindMatrices')
        if idx is None or idx in done:
            continue
        done.add(idx)
        arr, comp, ncomp, stride, start = acc_view(g, bin_data, idx)
        # glTF 的 MAT4 是列主序的平铺 16 个 float：第 12/13/14 个才是平移。
        # 用 reshape(4,4) 再取 [0:3,3] 会取到第 3/7/11 个（旋转部分），是错的。
        m = arr.astype(np.float64).copy()
        m[:, 12:15] *= SCALE
        write_back(bin_data, m.astype(arr.dtype), comp, ncomp, stride, start)

def embed_textures(g, bin_data, folder):
    """DDS -> PNG -> 追加进 BIN，image 改成 bufferView 引用（单文件才不丢图）"""
    images = g.get('images', [])
    blurbs = []
    for im in images:
        uri = im.get('uri', '')
        src = os.path.join(folder, uri)
        if not os.path.isfile(src):
            raise SystemExit('贴图缺失: ' + src)
        img = Image.open(src).convert('RGBA')
        import io as _io
        buf = _io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        data = buf.getvalue()
        while len(bin_data) % 4:
            bin_data.append(0)
        offset = len(bin_data)
        bin_data.extend(data)
        g['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)})
        im.pop('uri', None)
        im['bufferView'] = len(g['bufferViews']) - 1
        im['mimeType'] = 'image/png'
        blurbs.append((os.path.basename(uri), len(data), img.size))
    return blurbs


def build_vrm_ext(g):
    name2node = {}
    for i, n in enumerate(g['nodes']):
        nm = n.get('name')
        if nm and nm not in name2node:
            name2node[nm] = i
    bones = {}
    missing = []
    for src, dst in BONE_MAP.items():
        if src in name2node:
            bones[dst] = {'node': name2node[src]}
        else:
            missing.append(src)
    for key, (left, right) in FINGER_MAP.items():
        for side, dst in (('L', left), ('R', right)):
            nm = 'SK_%s_%s' % (side, key)
            if nm in name2node:
                bones[dst] = {'node': name2node[nm]}
    required = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
                'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm',
                'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']
    lack = [b for b in required if b not in bones]
    if lack:
        raise SystemExit('缺少 VRM 必需骨骼: ' + ', '.join(lack) + '（源骨骼名对不上？）')
    return {
        'specVersion': '1.0',
        'meta': {
            'name': 'Ryza (Atelier Ryza 2)',
            'version': '1.0',
            'authors': ['local self-use extraction'],
            'licenseUrl': 'https://vrm.dev/licenses/1.0/',
            'avatarPermission': 'onlyAuthor',
            'allowExcessivelyViolentUsage': False,
            'allowExcessivelySexualUsage': False,
            'commercialUsage': 'personalNonProfit',
            'creditNotation': 'unnecessary',
            'allowRedistribution': False,
            'modification': 'allowModification',
        },
        'humanoid': {'humanBones': bones},
    }, missing


def write_glb(g, bin_data, out_path):
    g.setdefault('buffers', [])
    g['buffers'] = [{'byteLength': len(bin_data)}]
    g['asset'] = {'version': '2.0', 'generator': 'ryza2 extractor (build_vrm.py)'}
    js = json.dumps(g, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    while len(js) % 4:
        js += b' '
    while len(bin_data) % 4:
        bin_data.append(0)
    total = 12 + 8 + len(js) + 8 + len(bin_data)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(bin_data), 0x004E4942))
        f.write(bytes(bin_data))


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else '.'
    base = sys.argv[2] if len(sys.argv) > 2 else 'PC20A_MODEL_default'
    out_name = sys.argv[3] if len(sys.argv) > 3 else base.lower() + '.vrm'
    g, bin_data = load_gltf(folder, base)

    # 先记下每张贴图的 alpha 特征（决定 MASK 与否）
    alpha_stats = {}
    for i, im in enumerate(g.get('images', [])):
        uri = im.get('uri', '')
        p = os.path.join(folder, uri)
        if os.path.isfile(p):
            a = np.asarray(Image.open(p).convert('RGBA').split()[-1], dtype=np.uint8)
            alpha_stats[i] = (float((a > 250).mean()), float((a < 5).mean()))

    scale_model(g, bin_data)
    scale_ibm(g, bin_data)
    blurbs = embed_textures(g, bin_data, folder)

    used_images = set()
    for m in g.get('materials', []):
        pbr = m.setdefault('pbrMetallicRoughness', {})
        pbr['metallicFactor'] = 0.0
        pbr['roughnessFactor'] = 0.86
        tex = pbr.get('baseColorTexture')
        if tex is not None:
            src = g['textures'][tex['index']].get('source')
            if src is not None:
                used_images.add(src)
                op, zero = alpha_stats.get(src, (1.0, 0.0))
                # 只有「真的有大片透明」才开 mask，否则身体贴图会被挖出洞
                if zero > 0.002 or op < 0.99:
                    m['alphaMode'] = 'MASK'
                    m['alphaCutoff'] = 0.5
        # 游戏贴图里已经烘焙了明暗，走「无光照」(KHR_materials_unlit) => three 里是 MeshBasicMaterial，
        # 颜色与游戏里一致。试过 MToon：这套 three(0.186)+three-vrm(3.5.5) 组合下 MToon 渲染发白不可用；
        # 而普通 PBR 在 app 那盏朝下的平行光下会把竖直面（脸）照成纯黑。
        m['extensions'] = {'KHR_materials_unlit': {}}
        m['doubleSided'] = True

    ext, missing = build_vrm_ext(g)
    # VRM 1.0 的扩展名是 VRMC_vrm（VRM 0.x 才叫 VRM），写错 three-vrm 会静默当成普通 glTF
    g.setdefault('extensionsUsed', [])
    if 'VRMC_vrm' not in g['extensionsUsed']:
        g['extensionsUsed'].append('VRMC_vrm')
    if 'KHR_materials_unlit' not in g['extensionsUsed']:
        g['extensionsUsed'].append('KHR_materials_unlit')
    g.setdefault('extensions', {})['VRMC_vrm'] = ext
    # three-vrm 只在认得的扩展里找 VRM，extensionsRequired 不要放 VRM（否则老解析器会拒）
    g['extensionsRequired'] = [e for e in g.get('extensionsRequired', []) if e not in ('VRM', 'VRMC_vrm')]

    out_path = os.path.join(folder, out_name)
    write_glb(g, bin_data, out_path)

    tri = 0
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            if p.get('indices') is not None:
                tri += g['accessors'][p['indices']]['count'] // 3
    hm = [max(g['accessors'][p['attributes']['POSITION']]['max'][1] for p in m['primitives'])
          for m in g['meshes']]
    print('输出     ', out_path, '%.1f MB' % (os.path.getsize(out_path) / 1048576))
    print('网格     ', len(g['meshes']), '个 / 三角面', tri)
    print('身高(米) ', round(max(hm), 3))
    print('贴图     ', len(blurbs), '张 PNG 内嵌，共 %.1f MB' % (sum(b[1] for b in blurbs) / 1048576))
    print('humanoid ', len(ext['humanoid']['humanBones']), '根', ('（源里没有: %s）' % ', '.join(missing)) if missing else '')
    mats = [m.get('name') for m in g.get('materials', [])]
    print('材质     ', len(mats), mats)
    mask = [m.get('name') for m in g.get('materials', []) if m.get('alphaMode') == 'MASK']
    print('透明(MASK)', mask if mask else '无')


if __name__ == '__main__':
    main()
