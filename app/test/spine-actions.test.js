// 0.46.9 语义动作自动调用（AgentAtelierR 规则 1:1 移植）防回归
//  - spine-actions.js：11 个语义标签 × sit/stand 计划齐全，引用的组号都真实存在于
//    spine-words.js 目录（对应骨架），one-shot 回退名合法
//  - petBridge.extractInlineAct：正文内嵌 [action:标签] 被剥掉并归一成 'action:xxx' 词，
//    未知标签/普通方括号文本不误伤
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const APP = path.join(__dirname, '..')

function loadIife (rel) {
  const code = fs.readFileSync(path.join(APP, rel), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(code)()
}

test('spine-actions: 11 个语义标签，sit/stand 计划齐全', () => {
  loadIife('src/renderer/shared/spine-actions.js')
  const tags = globalThis.SPINE_ACTION_TAGS
  const plans = globalThis.SPINE_ACTION_PLANS
  const want = ['acknowledge', 'disagree', 'think', 'explain', 'excited', 'wave', 'shy', 'surprised', 'comfort', 'playful', 'invite']
  assert.deepEqual(Object.keys(tags).sort(), [...want].sort())
  for (const sk of ['sit', 'stand']) {
    assert.deepEqual(Object.keys(plans[sk]).sort(), [...want].sort(), sk + ' 计划缺标签')
    for (const t of want) {
      const p = plans[sk][t]
      assert.ok(Array.isArray(p.groups), sk + '/' + t + ' groups 应为数组')
      if (!p.groups.length) assert.ok(p.oneShot, sk + '/' + t + ' 无候选组时必须有 oneShot 回退')
      if (p.oneShot) assert.match(p.oneShot, /^motion_oneshot_D_\d{3}_active$/)
    }
  }
})

test('spine-actions: 计划引用的组号都存在于对应骨架目录', () => {
  loadIife('src/renderer/shared/spine-words.js')
  loadIife('src/renderer/shared/spine-actions.js')
  const cat = globalThis.SPINE_GROUP_CATALOG
  const plans = globalThis.SPINE_ACTION_PLANS
  for (const sk of ['sit', 'stand']) {
    for (const [t, p] of Object.entries(plans[sk])) {
      for (const gid of p.groups) {
        assert.ok(cat[sk][gid], `${sk}/${t} 引用的 ${gid} 不在 ${sk} 目录里`)
        assert.ok(cat[sk][gid].anims.length, gid + ' 目录里没有动画名')
        assert.ok(!cat[sk][gid].off, `${sk}/${t} 引用了资源注明不使用的组 ${gid}`)
      }
    }
  }
})

test('petBridge.extractInlineAct: [action:标签] 剥离 + 归一成 action: 词', () => {
  const pb = require(path.join(APP, 'src/main/petBridge.js'))
  const r1 = pb.extractInlineAct('[action:think] そうだね、思い出した')
  assert.equal(r1.actions.length, 1)
  assert.equal(r1.actions[0], 'action:think')
  assert.equal(r1.text, 'そうだね、思い出した')
  // 直接组号也认
  const r2 = pb.extractInlineAct('你看这里[action:grp_fg_106]')
  assert.deepEqual(r2.actions, ['action:grp_fg_106'])
  assert.equal(r2.text, '你看这里')
  // 大小写 / 空格容错
  const r3 = pb.extractInlineAct('[Action: WAVE] やあ')
  assert.deepEqual(r3.actions, ['action:wave'])
  // 未知标签：标识符样的一律剥掉（不显示成乱码），渲染层按 none 不播
  const r4 = pb.extractInlineAct('被夸了 [action:happy] 开心')
  assert.deepEqual(r4.actions, ['action:happy'])
  assert.equal(r4.text, '被夸了 开心') // 末尾 extractInlineAct 会把连续空白折叠成一个空格
  // 非标识符（含空格/符号）不是动作标记，原样保留不误伤
  const r5 = pb.extractInlineAct('数组写法 [action: 1+1] 保留原样')
  assert.equal(r5.actions.length, 0)
  assert.match(r5.text, /\[action: 1\+1\]/)
  // 普通 <pet_act> 链路不受影响
  const r6 = pb.extractInlineAct('好<pet_act>【拍手】</pet_act>')
  assert.deepEqual(r6.actions, ['拍手'])
})

test('petBridge.extractInlineAct: 【…】舞台指示映射成动作并剥掉（0.46.13）', () => {
  const pb = require(path.join(APP, 'src/main/petBridge.js'))
  // 真机 21:41 实测的两句原话：模型写的是日文舞台指示而不是 [action:] 语法
  const r1 = pb.extractInlineAct('え、なんで分かったの……。【少し照れる】ずっとってわけじゃないよ。')
  assert.deepEqual(r1.actions, ['action:shy'])
  assert.ok(!r1.text.includes('少し照れる'), '舞台指示要从正文剥掉（不进 TTS/字幕）')
  assert.ok(r1.text.includes('ずっとってわけじゃないよ'))
  const r2 = pb.extractInlineAct('暇ってほどじゃないよ。……たまに「ちゃんと息してるかな」って思うだけ。【少し首をかしげる】')
  assert.deepEqual(r2.actions, ['action:think'])
  assert.ok(!r2.text.includes('首をかしげる'))
  // 认不出关键词的【…】原样保留（可能是正经强调文本，不误伤）
  const r3 = pb.extractInlineAct('【手帳】を見てた')
  assert.equal(r3.actions.length, 0)
  assert.ok(r3.text.includes('【手帳】'))
  // 中文舞台指示也认
  const r4 = pb.extractInlineAct('【微笑】そうだね')
  assert.deepEqual(r4.actions, ['轻笑'])
  // 每条回复最多取 2 个（动作闸之外的第二道限），超出的保留原文
  const r5 = pb.extractInlineAct('【害羞】【点头】【思考】三连')
  assert.equal(r5.actions.length, 2)
  assert.ok(r5.text.includes('【思考】'), '超限的舞台指示不剥')
  // 0.46.14 补漏：真机 21:55 【少し笑う】没接住——「笑う」是最高频舞台指示必须在表
  const r7 = pb.extractInlineAct('変だった？【少し笑う】だから、たまに呼んでね。')
  assert.deepEqual(r7.actions, ['轻笑'])
  assert.ok(!r7.text.includes('少し笑う'), '【少し笑う】也要从正文剥掉')
})
