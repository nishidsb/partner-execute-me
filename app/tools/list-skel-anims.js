// 导出 skel 里的全部动画名（用 spine-canvas 4.3 runtime，headless）
const fs = require('fs')
const path = require('path')
if (typeof globalThis.window === 'undefined') { globalThis.window = globalThis }

const spine = require('spine-canvas-42')

class FakeTexture { constructor () { this.width = 2048; this.height = 2048 } setFilters () {} dispose () {} }
class FakeLoader { load (cb) { if (typeof cb === 'function') cb(new FakeTexture()) } loadTexture (p, cb) { if (typeof cb === 'function') cb(new FakeTexture()) } }

function load (dir, base) {
  const atlasText = fs.readFileSync(path.join(dir, base + '.atlas'), 'utf8')
  const atlas = new spine.TextureAtlas(atlasText)
  const loader = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas))
  const data = loader.readSkeletonData(fs.readFileSync(path.join(dir, base + '.skel')))
  return data
}

const dir = process.argv[2] || 'C:/Users/username/AppData/Roaming/ryza-assistant-app/companion/assets/workspaceid/'
const base = process.argv[3] || 'crf_skn_002_0001_99'
try {
  const data = load(dir, base)
  console.log('版本:', data.version, '| 动画数:', data.animations.length, '| 皮肤数:', data.skins.length)
  for (const a of data.animations) console.log(a.name)
} catch (e) {
  console.log('FAIL', e && e.message)
  process.exit(1)
}
