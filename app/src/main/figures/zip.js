'use strict'
/**
 * 零依赖最小 zip 读取器（只读，够形象包用）
 *   - 只支持 store(0) / deflate(8)，其它压缩方法直接报错（形象包里的图片本来就不压缩）
 *   - zip64 不支持：条目大小/偏移出现 0xFFFFFFFF 直接拒绝，避免解出半截数据
 *   - 路径穿越（../、绝对路径、盘符、反斜杠）在入口处就拦掉，绝不落盘到目标目录之外
 * 为什么不引第三方库：安装包体积与供应链风险，而且形象包格式由我们自己定义
 */
const zlib = require('node:zlib')

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

function findEocd (buf) {
  // EOCD 固定在尾部 22 + 最多 65535 字节注释里
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 规范化条目路径：统一正斜杠，拒绝越界 */
function safeName (raw) {
  const name = String(raw || '').replace(/\\/g, '/').trim()
  if (!name) return ''
  if (/^[a-zA-Z]:/.test(name)) return '' // C:/...
  if (name.startsWith('/')) return ''
  const parts = []
  for (const seg of name.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return ''
    parts.push(seg)
  }
  const out = parts.join('/')
  // 深度限制：形象包最多 3 层目录（figure.json 在根，贴图放子目录足够）
  if (out.split('/').length > 4) return ''
  return out
}

/**
 * @param {Buffer} buf
 * @returns {{ ok:boolean, reason?:string, entries:Array<{name:string,size:number,data:Buffer}> }}
 */
function readZip (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, reason: '不是有效的 zip 文件', entries: [] }
  const eocd = findEocd(buf)
  if (eocd < 0) return { ok: false, reason: '找不到 zip 目录（文件损坏或不是 zip）', entries: [] }

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOff === 0xffffffff) return { ok: false, reason: '不支持 zip64 格式', entries: [] }
  if (cdOff + cdSize > buf.length) return { ok: false, reason: 'zip 目录越界（文件损坏）', entries: [] }

  const entries = []
  const seen = new Set()
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      return { ok: false, reason: 'zip 目录条目损坏', entries: [] }
    }
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const lfhOff = buf.readUInt32LE(p + 42)
    const rawName = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (csize === 0xffffffff || usize === 0xffffffff || lfhOff === 0xffffffff) {
      return { ok: false, reason: '不支持 zip64 格式', entries: [] }
    }
    if (rawName.endsWith('/')) continue // 目录条目
    const name = safeName(rawName)
    if (!name) return { ok: false, reason: '压缩包里有非法路径：' + rawName, entries: [] }
    if (seen.has(name)) return { ok: false, reason: '压缩包里有重复文件：' + name, entries: [] }
    seen.add(name)

    if (lfhOff + 30 > buf.length || buf.readUInt32LE(lfhOff) !== LFH_SIG) {
      return { ok: false, reason: 'zip 文件头损坏：' + name, entries: [] }
    }
    const lNameLen = buf.readUInt16LE(lfhOff + 26)
    const lExtraLen = buf.readUInt16LE(lfhOff + 28)
    const dataOff = lfhOff + 30 + lNameLen + lExtraLen
    if (dataOff + csize > buf.length) return { ok: false, reason: 'zip 数据越界：' + name, entries: [] }

    const raw = buf.slice(dataOff, dataOff + csize)
    let data
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1024 })
      } catch (e) {
        return { ok: false, reason: '解压失败：' + name + '（' + (e && e.message) + '）', entries: [] }
      }
    } else {
      return { ok: false, reason: '不支持的压缩方式 ' + method + '：' + name, entries: [] }
    }
    entries.push({ name, size: data.length, data })
  }
  return { ok: true, entries }
}

module.exports = { readZip, safeName }
