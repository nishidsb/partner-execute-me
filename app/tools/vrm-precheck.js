'use strict'
/**
 * 3D 模型静态体检（不启动窗口、不依赖 Electron）
 *   node tools/vrm-precheck.js <model.vrm|model.glb>
 *
 * 干什么：把 Ryza 渲染层判断「这模型能不能用」的几条硬条件，提前在命令行查出来——
 *   - 是不是 GLB 容器（Ryza 只认单文件 .vrm/.glb；.gltf + .bin 会丢网格）
 *   - 贴图是否全部内嵌（导入时只拷贝单个文件，外链图 = 白模）
 *   - 身高是否落在米制人体区间（相机近/远平面 0.1/50，按包围盒取景）
 *   - humanoid 骨骼够不够（缺大腿 = 不会走路，只会平移）
 *   - 有没有动画片段 + 有没有 walk 片段（vrm-stage 有片段就只用片段，
 *     只带 idle 不带 walk 会「呼吸正常但走起来是滑的」）
 *   - 是否要求 DRACO / KTX2 / meshopt 解码器（没挂 → 加载直接失败）
 *
 * 退出码：0 = 能导入（可能有警告），1 = 致命问题，2 = 文件读不了/格式不认
 */
const fs = require('node:fs')
const path = require('node:path')

const MAGIC_GLTF = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const WALK_RE = /walk|run|jog|歩|走|move/i
// 没有解码器的扩展：命中就是加载失败，不是「可能有点问题」
const NEED_DECODER = ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression']

function parseGlb (buf) {
  if (!buf || buf.length < 20) throw new Error('文件太小，不像是 GLB')
  if (buf.readUInt32LE(0) !== MAGIC_GLTF) {
    throw new Error('不是 GLB 容器（magic 不是 glTF）。.gltf + .bin 这种分离格式 Ryza 不支持，请导出 .vrm/.glb')
  }
  const ver = buf.readUInt32LE(4)
  if (ver !== 2) throw new Error('glTF 版本是 ' + ver + '，只支持 2')
  const total = buf.readUInt32LE(8)
  const end = Math.min(buf.length, total || buf.length)
  let off = 12
  let json = null
  while (off + 8 <= end) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    if (len < 0 || off + 8 + len > buf.length) break
    if (type === CHUNK_JSON && !json) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
    off += 8 + len
    if (len % 4) off += 4 - (len % 4) // 容错：个别导出器少补了对齐位
  }
  if (!json) throw new Error('GLB 里没有 JSON 块（文件可能被截断）')
  return json
}

/* 纯函数：吃 glTF JSON，吐体检结果（单测直接喂对象） */
function inspect (json, bytes) {
  json = json || {}
  const r = {
    bytes: bytes || 0,
    generator: String((json.asset && json.asset.generator) || ''),
    vrm: null,          // '0.x' / '1.0' / null(=普通 GLB)
    title: '',
    bones: [],
    height: null,
    scaled: 0,          // 带非 1 缩放的节点数（身高估算会偏）
    images: { embedded: 0, dataurl: 0, external: 0 },
    externalNames: [],
    anims: [],
    tris: 0,
    meshes: 0,
    materials: (json.materials || []).length,
    required: (json.extensionsRequired || []).slice(),
    fatal: [],
    warn: []
  }

  // ---------- VRM 与人形骨骼 ----------
  // VRM 1.0 的扩展名是 VRMC_vrm（humanBones 是对象），VRM 0.x 才叫 VRM（humanBones 是数组）。
  // 只认 VRM 会把 1.0 的模型误判成「普通 GLB」。
  const ext1 = (json.extensions && json.extensions.VRMC_vrm) || null
  const ext0 = (json.extensions && json.extensions.VRM) || null
  const ext = ext1 || ext0
  if (ext) {
    const hb = (ext.humanoid && ext.humanoid.humanBones) || null
    if (Array.isArray(hb)) {
      // VRM 0.x：数组 [{ bone, node }]
      r.vrm = '0.x'
      hb.forEach((b) => { if (b && b.bone && r.bones.indexOf(String(b.bone)) < 0) r.bones.push(String(b.bone)) })
    } else if (hb && typeof hb === 'object') {
      // VRM 1.0：对象 { hips: { node }, ... }
      r.vrm = '1.0'
      r.bones = Object.keys(hb)
    } else {
      r.vrm = String(ext.specVersion || (ext1 ? '1.0' : '0.x'))
    }
    const meta = ext.meta || {}
    r.title = String(meta.title || meta.name || '')
  } else if ((json.extensionsUsed || []).some((e) => e === 'VRM' || e === 'VRMC_vrm')) {
    r.warn.push('声明了 VRM 扩展但 extensions 里没有对应内容 —— three-vrm 会退回普通 glTF，没有表情/不会走路')
  }

  // ---------- 身高 & 面数 ----------
  const accs = json.accessors || []
  let minY = Infinity
  let maxY = -Infinity
  let hasPos = false
  for (const m of json.meshes || []) {
    r.meshes++
    for (const p of m.primitives || []) {
      const posIdx = p.attributes && p.attributes.POSITION
      if (posIdx == null) continue
      const a = accs[posIdx]
      if (!a) continue
      if (Array.isArray(a.min) && Array.isArray(a.max) && a.min.length >= 2 && a.max.length >= 2) {
        hasPos = true
        if (a.min[1] < minY) minY = a.min[1]
        if (a.max[1] > maxY) maxY = a.max[1]
      }
      let verts = typeof a.count === 'number' ? a.count : 0
      const ia = p.indices != null ? accs[p.indices] : null
      if (ia && typeof ia.count === 'number') verts = ia.count
      r.tris += Math.round(verts / 3)
    }
  }
  if (hasPos) r.height = Math.round((maxY - minY) * 1000) / 1000
  for (const n of json.nodes || []) {
    const s = n.scale
    if (Array.isArray(s) && (Math.abs(s[0] - 1) > 1e-6 || Math.abs(s[1] - 1) > 1e-6 || Math.abs(s[2] - 1) > 1e-6)) r.scaled++
    else if (Array.isArray(n.matrix) && Math.abs(n.matrix[0] - 1) > 1e-6) r.scaled++
  }

  // ---------- 贴图 ----------
  for (const im of json.images || []) {
    if (im.bufferView != null) r.images.embedded++
    else if (im.uri && /^data:/i.test(im.uri)) r.images.dataurl++
    else if (im.uri) {
      r.images.external++
      if (r.externalNames.length < 5) r.externalNames.push(String(im.uri))
    } else r.images.embedded++ // 既无 uri 也无 bufferView：当内嵌占位，不误报
  }

  // ---------- 动画 ----------
  for (const a of json.animations || []) r.anims.push(String(a.name || '(未命名)'))

  // ---------- 判定 ----------
  for (const k of r.required) {
    if (NEED_DECODER.includes(k)) r.fatal.push('需要 ' + k + ' 解码器，Ryza 的 GLTFLoader 没挂 → 加载会直接失败（Blender 导出时别勾 Draco/压缩）')
  }
  if (!r.vrm) {
    r.warn.push('不是 VRM（普通 GLB）：能显示，但没有表情/口型，也不会程序化走路 —— 除非它自带 walk 动画')
  } else {
    const has = (n) => r.bones.indexOf(n) >= 0
    if (!has('leftUpperLeg') && !has('rightUpperLeg')) {
      r.warn.push('humanoid 里没有大腿骨：程序化走路不可用，角色只会平移')
    }
    if (!has('leftUpperArm') && !has('rightUpperArm')) r.warn.push('没有上臂骨：走路时手臂不会摆动')
    if (!has('hips')) r.warn.push('没有 hips：three-vrm 归一化骨骼基本不可用')
    if (!has('head')) r.warn.push('没有 head：说话不会朝向你（外观影响小）')
  }
  if (r.images.external) {
    r.warn.push('有 ' + r.images.external + ' 张贴图是外链文件（' + r.externalNames.join(', ') + '）：导入时只拷单个文件，会变白模 —— 导出时选「内嵌贴图」')
  }
  if (r.height != null) {
    if (r.height > 8 || (r.height > 0 && r.height < 0.6)) {
      r.warn.push('身高 ' + r.height + '：单位不像米。Ryza 相机 0.1/50 按包围盒取景，这种尺寸会整只看不见 —— 在 Blender 里缩到 1.5 m')
    } else if (r.height < 1.2 || r.height > 2.0) {
      r.warn.push('身高 ' + r.height + ' m：偏离常见人体区间（1.2~2.0），取景会偏松或偏紧')
    }
    if (r.scaled) r.warn.push('有 ' + r.scaled + ' 个节点带非 1 缩放，身高估算可能不准（遍历顶点才准）')
  } else {
    r.warn.push('accessor 里没有 POSITION min/max，量不出身高')
  }
  if (r.anims.length) {
    const hasWalk = r.anims.some((n) => WALK_RE.test(n))
    if (!hasWalk) {
      r.warn.push('带了 ' + r.anims.length + ' 段动画但没有 walk 片段：vrm-stage 有片段就只用片段 → 呼吸正常但走路是平移。要么一段都别带，要么 idle+walk 都带')
    }
  }
  if (r.tris > 300000) r.warn.push('约 ' + r.tris + ' 个三角面：桌面小窗用不上，建议 Decimate 到 5 万以内')
  if (r.bytes > 200 * 1024 * 1024) r.warn.push('文件 ' + Math.round(r.bytes / 1048576) + ' MB：每个角色一份拷贝，会明显拖慢角色切换')

  return r
}

function format (r) {
  const L = []
  L.push('文件      ' + (r.bytes ? Math.round(r.bytes / 1024) + ' KB' : '?'))
  L.push('类型      ' + (r.vrm ? 'VRM ' + r.vrm + (r.title ? '（' + r.title + '）' : '') : '普通 glTF / GLB'))
  if (r.generator) L.push('生成器    ' + r.generator)
  L.push('网格      ' + r.meshes + ' 个 / 三角面约 ' + r.tris + ' / 材质 ' + r.materials)
  L.push('身高      ' + (r.height == null ? '测不出' : r.height + ' m'))
  L.push('贴图      ' + r.images.embedded + ' 内嵌 + ' + r.images.dataurl + ' dataURL + ' + r.images.external + ' 外链')
  L.push('动画      ' + (r.anims.length ? r.anims.length + ' 段：' + r.anims.slice(0, 6).join(', ') : '无（Ryza 走程序化姿态，正常）'))
  if (r.vrm) L.push('骨骼      ' + (r.bones.length ? r.bones.length + ' 根 humanoid：' + r.bones.slice(0, 12).join(', ') + (r.bones.length > 12 ? ' …' : '') : '未声明'))
  if (r.required.length) L.push('必需扩展  ' + r.required.join(', '))
  if (r.fatal.length) {
    L.push('')
    for (const f of r.fatal) L.push('  ✗ ' + f)
  }
  if (r.warn.length) {
    L.push('')
    for (const w of r.warn) L.push('  ! ' + w)
  }
  L.push('')
  L.push(r.fatal.length ? '结论：不能导入（先解决 ✗）' : '结论：可以导入' + (r.warn.length ? '（' + r.warn.length + ' 条提醒见上）' : ''))
  return L.join('\n')
}

function main () {
  const arg = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0]
  if (!arg) {
    console.error('用法: node tools/vrm-precheck.js <model.vrm|model.glb>')
    process.exit(2)
  }
  const file = path.resolve(arg)
  let buf
  try { buf = fs.readFileSync(file) } catch (e) {
    console.error('[precheck] 读不到文件:', file, e.message)
    process.exit(2)
  }
  if (/\.gltf$/i.test(file)) {
    console.error('[precheck] .gltf 是分离格式（模型 + 外部 .bin/贴图），Ryza 只接受单文件，请导出 .vrm/.glb')
    process.exit(2)
  }
  let json
  try { json = parseGlb(buf) } catch (e) {
    console.error('[precheck] 解析失败:', e.message)
    process.exit(2)
  }
  const r = inspect(json, buf.length)
  console.log('[precheck] ' + file)
  console.log(format(r))
  process.exit(r.fatal.length ? 1 : 0)
}

module.exports = { parseGlb, inspect, format }

if (require.main === module) main()
