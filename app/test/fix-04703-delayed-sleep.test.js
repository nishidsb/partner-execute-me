'use strict'
/** 0.47.3 延后宣言否决回归（11-08 23:39 实锤）：
 *  主人说「我再过一眼公式我就躺下了，莱莎基本从现在开始就可以自由使用电脑了」，
 *  「躺下了」命中强宣言词表 → 判成马上去睡 → QQ 发晚安 + 静默到早上 6:39。
 *  「再/等/看完/弄完…就(躺下/睡)」是将来时——还差一件事才睡，不许当就寝宣言。
 *  真告别（晚安/おやすみ/good night）压过延后否决；立刻型宣言不受影响。 */
const { test } = require('node:test')
const assert = require('node:assert')
const idleNudge = require('../src/main/companion/idleNudge')

const NIGHT = new Date('2026-11-08T23:39:00+08:00').getTime()
const MORNING = new Date('2026-11-08T11:00:00+08:00').getTime()

test('0.47.3 真机原句：将来时「再…就躺下了」不算就寝宣言', () => {
  assert.equal(idleNudge.declaresSleep('我再过一眼公式我就躺下了，莱莎基本从现在开始就可以自由使用电脑了', NIGHT), false)
})

test('0.47.3 延后句式家族一律否决', () => {
  for (const s of ['等我把这集看完就去睡', '待会就躺下了', '我复习完就睡', '回头再睡', '弄完手头这点事我就上床了']) {
    assert.equal(idleNudge.declaresSleep(s, NIGHT), false, s)
  }
})

test('0.47.3 真告别压过延后否决：说了晚安就是现在说', () => {
  assert.equal(idleNudge.declaresSleep('我再看一集就睡，晚安', NIGHT), true)
})

test('0.47.3 立刻型宣言不受延后否决影响（回归）', () => {
  for (const s of ['我躺下了', '我先睡了，晚安', '马上就去睡', '熬夜到两点，先睡了，晚安']) {
    assert.equal(idleNudge.declaresSleep(s, NIGHT), true, s)
  }
})

test('0.47.3 历次否决修复全部保住（0.46.60 主语 / 0.46.69 邀请 / 0.46.74 问句+回忆+白天闸）', () => {
  assert.equal(idleNudge.declaresSleep('你睡了吗', NIGHT), false)
  assert.equal(idleNudge.declaresSleep('要是莱莎困了就先睡吧', NIGHT), false)
  assert.equal(idleNudge.declaresSleep('我这边可以好好休息了，来一起看视频吧', NIGHT), false)
  assert.equal(idleNudge.declaresSleep('睡了几个小时，应该还好吧', MORNING), false)
})
