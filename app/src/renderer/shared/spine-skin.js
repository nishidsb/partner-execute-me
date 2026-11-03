/**
 * Spine 骨架/皮肤选择 · 0.45.91
 *
 * 用户 11-02：「角色 spine 有时候会自动换成其他皮肤」。
 * 根因：坐卡/原地坐下时整个骨架被切到 sitSkel —— 而 sitSkel 配的是 0001_01（常服），
 * 主形象是 0005_01（白蓝比基尼）。于是她一坐就换衣服，一起身又换回来。
 *
 * 事实核对（tools/list-skel-anims.js，11-02）：
 *   0005_01 741 条 / 592 条 motion_*，已含坐姿组（motion_add_B_* / motion_add_C_*）
 *   与拍手（motion_add_F_050 / G_050）—— 她自己的皮肤本来就够用，根本不需要借骨架。
 *   0001_01 867 条、0001_99 165 条：这两个同属 0001 常服，互换只是站/坐姿态差异。
 *
 * 所以规则改成：**只有同一套皮肤之间才允许换骨架**（0001_99 ⇄ 0001_01 是合法姿态切换），
 * 皮肤不同（0005 → 0001）一律沿用当前骨架，绝不换衣服。
 *
 * 纯函数，浏览器里挂 window.SPINE_SKIN，node 里可直接 require 做单测。
 */
;(function (root) {
  /** 从骨架路径里取皮肤号：crf_skn_002_0005_01.skel → "0005"；取不到返回 '' */
  function outfitId (p) {
    const m = String(p || '').match(/(?:^|[\\/_\s])(\d{4})_\d{2}(?:[.\-_]|$)/)
    return m ? m[1] : ''
  }

  /** 两个骨架是不是同一套皮肤（任一侧解析不出 → 当作同套，保持老行为，别把功能关死） */
  function sameOutfit (a, b) {
    const x = outfitId(a)
    const y = outfitId(b)
    if (!x || !y) return true
    return x === y
  }

  /**
   * 当前姿势该用哪套骨架。
   * @param {object} o { mode: 'stand'|'sit', spine: { skel, atlas, png, sitSkel, sitAtlas, sitPng } }
   * @returns {{skel,atlas,png,switched:boolean,reason:string}}
   *   switched=false 表示沿用当前骨架（不换皮肤）；reason 只用于日志/排查
   */
  function pickSkel (o) {
    const mode = (o && o.mode) === 'sit' ? 'sit' : 'stand'
    const sp = (o && o.spine) || {}
    const base = { skel: sp.skel, atlas: sp.atlas, png: sp.png, switched: false, reason: 'stand' }
    if (mode !== 'sit') return base
    if (!sp.sitSkel) return Object.assign(base, { reason: 'no-sit-skel' })
    if (!sameOutfit(sp.skel, sp.sitSkel)) {
      // 不同皮肤：坐下不换衣服（她的骨架自带坐姿动作，够用）
      return Object.assign(base, { reason: 'other-outfit' })
    }
    if (String(sp.sitSkel) === String(sp.skel)) return Object.assign(base, { reason: 'same-file' })
    return {
      skel: sp.sitSkel,
      atlas: sp.sitAtlas || sp.atlas,
      png: sp.sitPng || sp.png,
      switched: true,
      reason: 'same-outfit'
    }
  }

  const api = { outfitId, sameOutfit, pickSkel }
  root.SPINE_SKIN = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
