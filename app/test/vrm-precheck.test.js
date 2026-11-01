'use strict'
/* vrm-precheck 的判定逻辑测试
 * 用合成 GLB（合法容器 + 手写 glTF JSON）覆盖各种「能导入 / 不能导入」的情形，
 * 不依赖任何真实模型文件。 */
const test = require('node:test')
const assert = require('node:assert')
const { parseGlb, inspect, format } = require('../tools/vrm-precheck.js')

function glb (json) {
  const str = Buffer.from(JSON.stringify(json), 'utf8')
  const pad = (4 - (str.length % 4)) % 4
  const chunk = Buffer.concat([str, Buffer.alloc(pad, 0x20)])
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + chunk.length, 8)
  const ch = Buffer.alloc(8)
  ch.writeUInt32LE(chunk.length, 0)
  ch.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([head, ch, chunk])
}

const FULL_BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']

/** 造一份 VRM 1.0 的最小合法 JSON。opts 用来逐项破坏 */
function vrm1 (opts) {
  const o = opts || {}
  const bones = (o.bones || FULL_BONES).reduce((acc, b) => { acc[b] = { node: 1 }; return acc }, {})
  return {
    asset: { version: '2.0', generator: 'test' },
    extensionsUsed: ['VRMC_vrm', 'KHR_materials_unlit'],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: { name: 'Ryza' },
        humanoid: { humanBones: bones }
      }
    },
    nodes: [{ name: 'root' }],
    materials: [{ name: 'skin' }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        material: 0
      }]
    }],
    accessors: [{ type: 'VEC3', count: 300, min: [0, 0, 0], max: [0.4, o.height == null ? 1.5 : o.height, 0.2] }],
    images: o.images || [{ bufferView: 0, mimeType: 'image/png' }],
    animations: o.anims || undefined
  }
}

test('VRM 1.0 骨骼齐全 + 贴图内嵌 + 1.5m → 零警告', () => {
  const r = inspect(vrm1(), 1024)
  assert.equal(r.vrm, '1.0')
  assert.equal(r.height, 1.5)
  assert.equal(r.tris, 100)
  assert.equal(r.fatal.length, 0)
  assert.deepEqual(r.warn, [], '不该有警告：' + r.warn.join(' / '))
  assert.equal(r.title, 'Ryza')
})

test('VRM 0.x 的数组式 humanBones 也认（扩展名是 VRM）', () => {
  const json = vrm1()
  json.extensionsUsed = ['VRM']
  json.extensions = { VRM: { specVersion: '0.0', humanoid: { humanBones: FULL_BONES.map((b) => ({ bone: b, node: 1 })) } } }
  const r = inspect(json, 1)
  assert.equal(r.vrm, '0.x')
  assert.equal(r.bones.length, FULL_BONES.length)
  assert.equal(r.warn.filter((w) => /大腿|上臂|hips/.test(w)).length, 0)
})

test('缺大腿骨 → 提示不会走路', () => {
  const bones = FULL_BONES.filter((b) => !/Leg|Foot/.test(b))
  const r = inspect(vrm1({ bones }), 1)
  assert.ok(r.warn.some((w) => w.includes('大腿骨')), r.warn.join(' / '))
  assert.equal(r.fatal.length, 0)
})

test('贴图外链 → 提示会变白模', () => {
  const r = inspect(vrm1({ images: [{ uri: 'textures/body.png' }] }), 1)
  assert.equal(r.images.external, 1)
  assert.ok(r.warn.some((w) => w.includes('外链') && w.includes('body.png')), r.warn.join(' / '))
})

test('dataURL 贴图算内嵌，不报警', () => {
  const r = inspect(vrm1({ images: [{ uri: 'data:image/png;base64,AAAA' }] }), 1)
  assert.equal(r.images.dataurl, 1)
  assert.equal(r.warn.filter((w) => w.includes('外链')).length, 0)
})

test('身高 160（厘米单位）→ 提示单位不像米', () => {
  const r = inspect(vrm1({ height: 160 }), 1)
  assert.equal(r.height, 160)
  assert.ok(r.warn.some((w) => w.includes('单位不像米')), r.warn.join(' / '))
})

test('身高 2.4（异常偏高）→ 只提示偏离，不判成单位错', () => {
  const r = inspect(vrm1({ height: 2.4 }), 1)
  assert.ok(r.warn.some((w) => w.includes('偏离常见人体区间')), r.warn.join(' / '))
  assert.ok(!r.warn.some((w) => w.includes('单位不像米')))
})

test('DRACO 压缩 → 致命（加载器没解码器）', () => {
  const json = vrm1()
  json.extensionsRequired = ['KHR_draco_mesh_compression']
  const r = inspect(json, 1)
  assert.equal(r.fatal.length, 1)
  assert.ok(r.fatal[0].includes('draco'))
  assert.ok(format(r).includes('不能导入'))
})

test('只带 idle 不带 walk → 提示走路会平移', () => {
  const r = inspect(vrm1({ anims: [{ name: 'idle' }] }), 1)
  assert.ok(r.warn.some((w) => w.includes('walk')), r.warn.join(' / '))
})

test('idle + walk 都有 → 不提示', () => {
  const r = inspect(vrm1({ anims: [{ name: 'idle' }, { name: 'Walk_F' }] }), 1)
  assert.ok(!r.warn.some((w) => w.includes('walk')), r.warn.join(' / '))
})

test('声明了 VRM 扩展但 extensions 里没内容 → 提示会被当普通 glTF', () => {
  const json = vrm1()
  delete json.extensions
  json.extensionsUsed = ['VRMC_vrm']
  const r = inspect(json, 1)
  assert.equal(r.vrm, null)
  assert.ok(r.warn.some((w) => w.includes('退回普通 glTF')), r.warn.join(' / '))
})

test('普通 GLB（无 VRM 扩展）→ 提示没有表情与程序化走路', () => {
  const json = vrm1()
  delete json.extensions
  json.extensionsUsed = ['KHR_materials_unlit']
  json.extensionsUsed = ['KHR_materials_unlit']
  const r = inspect(json, 1)
  assert.equal(r.vrm, null)
  assert.ok(r.warn.some((w) => w.includes('不是 VRM')), r.warn.join(' / '))
  assert.equal(r.fatal.length, 0)
})

test('面数过多 → 提示减面', () => {
  const json = vrm1()
  json.accessors[0].count = 1_200_000
  const r = inspect(json, 1)
  assert.ok(r.tris >= 300000)
  assert.ok(r.warn.some((w) => w.includes('三角面')))
})

test('parseGlb：真 GLB 容器能解出 JSON', () => {
  const json = parseGlb(glb(vrm1()))
  assert.equal(json.extensions.VRMC_vrm.specVersion, '1.0')
})

test('parseGlb：非 GLB / 截断文件抛错而不是崩', () => {
  assert.throws(() => parseGlb(Buffer.from('{"asset":{"version":"2.0"}}')), /不是 GLB/)
  assert.throws(() => parseGlb(Buffer.alloc(4)), /太小/)
  const half = glb(vrm1()).subarray(0, 24)
  assert.throws(() => parseGlb(half), /没有 JSON|截断/)
})

test('format：把关键行都打出来', () => {
  const txt = format(inspect(vrm1({ anims: [{ name: 'idle' }] }), 100 * 1024))
  for (const k of ['类型', '身高', '贴图', '动画', '骨骼', '结论']) {
    assert.ok(txt.includes(k), '缺行：' + k)
  }
})
