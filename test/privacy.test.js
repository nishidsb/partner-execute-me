/**
 * 隐私守卫（0.46.52，2026-11-05）
 *
 * 本仓库是开源仓库。2026-11-05 实锤过一次事故：测试用例里带进了主人的真实对话
 * （含现实生活安排、私人情绪表达），18 个文件里硬编码了本机 Windows 用户名和
 * 工作区 ID——最后靠 git filter-repo 重写全历史才抹干净。
 *
 * 这个测试守住三条红线，任何一条命中都说明有带个人信息的东西被同步了进来：
 *   ① 本机身份信息：Windows 用户名、角色工作区 ID
 *   ② 主人的真实对话内容（已知事故原句的特征词）
 *   ③ 硬编码的真实用户目录（测试占位符 me/x/user/username 除外）
 *
 * 注：产品功能反馈类的表述（「用户 11-02 要求…」）不算个人信息，允许保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['app/src', 'app/test', 'app/tools', 'app/scripts', 'src', 'test', 'tools', 'scripts']

// 已知事故的特征词：出现即失败（宁可误报人工确认，不可漏报）。
// 特征词用碎片拼装——守卫文件自身也不能在源码里出现完整的敏感句。
const F = (...parts) => new RegExp(parts.join(''))
const FORBIDDEN = [
  F('6766a35a', '07'),                 // 角色工作区 ID
  F('线下面', '试'),                    // 真实生活安排
  F('感觉你好寂', '寞啊'),               // 私人情绪对话原句
  F('是不是不该在我', '离开家的时候', '打开你'), // 同上
  F('寂しくな', 'ったら、QQ のほうに行く', 'から'), // 私人约定原句
  F('11 点半', '说完就', '睡了')          // 作息细节
]

// 硬编码用户目录：C:\Users\<name>\ 或 C:/Users/<name>/，
// 放行通用占位符 me / x / user / username / test 等
const USER_DIR = /Users[\\/]+(?!me\b(?!-)|x\b|user(?:name)?\b|test\b|public\b|default\b)[A-Za-z0-9_-]{2,}[\\/]/

function* walk (dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      yield* walk(p)
    } else if (/\.(js|mjs|cjs|json|md|py|html|css|txt|yaml|yml)$/i.test(e.name)) {
      if (path.resolve(p) === path.resolve(fileURLToPath(import.meta.url))) continue   // 守卫自身含特征词，跳过
      yield p
    }
  }
}

test('隐私守卫：仓库里没有本机身份信息（用户名/工作区 ID）', () => {
  const offenders = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8')
      if (/[Aa]3595/.test(text)) offenders.push(path.relative(ROOT, file) + ' ← 疑似本机用户名')
    }
  }
  assert.deepStrictEqual(offenders, [], '发现本机身份信息，禁止提交：\n' + offenders.join('\n'))
})

test('隐私守卫：没有主人的真实对话内容', () => {
  const offenders = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8')
      for (const re of FORBIDDEN) {
        if (re.test(text)) offenders.push(path.relative(ROOT, file) + ' ← 命中 ' + re)
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '发现真实对话内容，禁止提交：\n' + offenders.join('\n'))
})

test('隐私守卫：没有硬编码的真实用户目录', () => {
  const offenders = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8')
      const m = text.match(USER_DIR)
      if (m) offenders.push(path.relative(ROOT, file) + ' ← C:\\Users\\' + m[1])
    }
  }
  assert.deepStrictEqual(offenders, [], '发现硬编码用户目录（改用环境变量或占位符）：\n' + offenders.join('\n'))
})
