'use strict'
/**
 * 工作区自动整理（0.19.0）：纯规划函数 + 真实落盘。
 * archive.js 是 ESM（跟 partner.js 同目录），这里用动态 import。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DAY = 86400000

async function mod () {
  return import('../src/assistant/core/memory/archive.js')
}

function entry (name, ageDays, isFile = true) {
  return { name, isFile, mtimeMs: Date.now() - ageDays * DAY }
}

test('planArchive：只碰 md/txt/json，PARTNER.md 永远不动', async () => {
  const { planArchive } = await mod()
  const picked = planArchive({
    entries: [
      entry('PARTNER.md', 400),
      entry('note.md', 60),
      entry('data.json', 60),
      entry('readme.txt', 60),
      entry('avatar.png', 60),
      entry('subdir', 60, false)
    ],
    maxAgeDays: 30,
    maxFiles: 100
  })
  assert.deepEqual(picked.sort(), ['data.json', 'note.md', 'readme.txt'])
})

test('planArchive：文件多的时候从最旧的开始移，且至少留 4 个', async () => {
  const { planArchive } = await mod()
  const entries = []
  for (let i = 0; i < 15; i++) entries.push(entry(`f${String(i).padStart(2, '0')}.md`, 1 + i))
  const picked = planArchive({ entries, maxAgeDays: 9999, maxFiles: 12 })
  // 15 个 → 超过 12；从最旧开始移，剩 12
  assert.equal(picked.length, 3)
  assert.ok(picked.includes('f14.md'), '最旧的先走')
  assert.ok(!picked.includes('f00.md'), '最新的留下')
  // 文件很少时（3 个、都没超龄）一个都不移
  assert.deepEqual(planArchive({ entries: entries.slice(0, 3), maxAgeDays: 9999, maxFiles: 12 }), [])
})

test('applyArchive：真把文件移进 archive/YYYY-MM，重名不覆盖', async () => {
  const { applyArchive } = await mod()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-ws-'))
  fs.writeFileSync(path.join(dir, 'PARTNER.md'), '# 人设')
  fs.writeFileSync(path.join(dir, 'old.md'), 'old')
  fs.writeFileSync(path.join(dir, 'new.md'), 'new')
  const old = new Date(Date.now() - 90 * DAY)
  fs.utimesSync(path.join(dir, 'old.md'), old, old)

  const r = applyArchive(dir, { maxAgeDays: 30, maxFiles: 12 })
  assert.deepEqual(r.moved, ['old.md'])
  assert.match(r.dir, /^archive[\\/]\d{4}-\d{2}$/)
  assert.ok(fs.existsSync(path.join(dir, r.dir, 'old.md')), '旧文件应该在归档目录里')
  assert.ok(fs.existsSync(path.join(dir, 'new.md')), '新文件留在根目录')
  assert.ok(fs.existsSync(path.join(dir, 'PARTNER.md')), 'PARTNER.md 不能被搬走')

  // 再放一个同名旧文件：不能覆盖已归档的那份
  fs.writeFileSync(path.join(dir, 'old.md'), 'old again')
  fs.utimesSync(path.join(dir, 'old.md'), old, old)
  applyArchive(dir, { maxAgeDays: 30, maxFiles: 12 })
  const names = fs.readdirSync(path.join(dir, r.dir))
  assert.equal(names.length, 2, '同名文件要加序号，不能覆盖')
})
