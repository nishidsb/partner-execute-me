/**
 * 接线审计自己的守卫（0.39.0）
 *
 * 用户要求：以后每次做功能或修 bug，都要遍历一遍有没有「写了没接上」的。
 * 那么审计脚本本身就不能是「跑一下看看」的摆设，得有护栏：
 *
 *   1. 基线里每一项都必须有理由，且不能是 TODO —— 没理由的基线 = 没审。
 *      这条最重要：基线最容易变成「把红的东西塞进去让它变绿」的垃圾桶。
 *   2. 基线里不能有已经消失的项（代码修好/删了要清掉），否则基线会越滚越大。
 *   3. 当前所有会判定失败的发现都必须在基线内（等价于 audit 退出码 0），
 *      不然 CI 里跑测试是绿的、跑 audit 是红的，两边打架。
 *   4. run() 的结构不能变（id/kind/file/name 齐全），否则基线匹配会静默失效——
 *      这正是 test/inner.test.js 那条「护栏正则早就匹配不到」的老毛病。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const { run, LABEL } = require('../tools/audit.js')

const baselinePath = path.join(ROOT, 'tools', 'audit-baseline.json')

function loadBaseline () {
  const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  assert.ok(raw && typeof raw.allow === 'object' && raw.allow, '基线要有 allow 对象')
  return raw
}

test('基线每一项都写了理由，且不是 TODO 占位', () => {
  const { allow } = loadBaseline()
  const bad = []
  for (const [id, v] of Object.entries(allow)) {
    const reason = String((v && v.reason) || '').trim()
    if (!reason || /^TODO/i.test(reason) || reason.length < 8) bad.push(id + ' → 「' + reason + '」')
  }
  assert.deepStrictEqual(bad, [], '这些基线项没写清为什么可以留着：\n' + bad.join('\n'))
})

test('基线里没有已经消失的项（修好了就要清掉）', () => {
  const { allow } = loadBaseline()
  const ids = new Set(run().map((f) => f.id))
  const stale = Object.keys(allow).filter((id) => !ids.has(id))
  assert.deepStrictEqual(stale, [], '这些基线项已经不存在了，跑 node tools/audit.js --prune 清掉：\n' + stale.join('\n'))
})

test('当前没有基线外的新增发现（等价于 audit 退出码 0）', () => {
  const { allow } = loadBaseline()
  const fresh = run().filter((f) => !f.warn && !allow[f.id])
  const detail = fresh.map((f) => '[' + f.kind + '] ' + f.file + ' → ' + f.name)
  assert.deepStrictEqual(detail, [], '这些是「写了没接上」，修掉或写进基线说明理由：\n' + detail.join('\n'))
})

test('每类发现都有可读标签（新增类别忘了写标签会显示成 undefined）', () => {
  for (const f of run()) {
    assert.ok(LABEL[f.kind], '缺少标签的类别：' + f.kind)
  }
})

test('发现项字段齐全（id 由字段拼成，缺字段会让基线静默失配）', () => {
  for (const f of run()) {
    assert.ok(f.id && typeof f.id === 'string', 'id 缺失')
    assert.ok(f.kind, f.id + ' 缺 kind')
    assert.ok(f.file, f.id + ' 缺 file')
    assert.ok(f.name, f.id + ' 缺 name')
    assert.ok(f.id.includes(f.name) || f.id.includes(':'), f.id + ' 的 id 与 name 对不上')
  }
})

test('护栏：常量导出与冗余导出不进基线（它们本来就不拦）', () => {
  const { allow } = loadBaseline()
  const ids = run().filter((f) => f.warn).map((f) => f.id)
  const polluted = ids.filter((id) => allow[id])
  assert.deepStrictEqual(polluted, [], '这些是 warn 级，不该占基线位置：\n' + polluted.join('\n'))
})
