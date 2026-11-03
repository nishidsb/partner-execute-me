/* 语义动作计划（0.46.9）：1:1 抄自 AgentAtelierR lib/src/character_performance.dart
 * （_seatedActionPlans / _standingActionPlans，核对日期 2026-11-02）。
 * 模型在回复正文嵌 [action:标签] 或直接 [action:grp_fg_106]，渲染层按当前骨架
 * （sit/stand）取计划里的动作组依次试播；全部选不中 → 回退 D 系一次性动画
 * （motion_oneshot_D_001~012，两副骨架都有，播放走 playSpineAction 的 oneshot 轨0 接回 idle）。
 * 与原版的差异：AgentAtelierR 还会用当前表情的 EmotionProfilesV4 手臂权重筛选候选组
 * （权重为 0 时选不中、回退 one-shot）；我们暂未接表情权重 → 候选组直接可用，
 * 动作频率更高（服务「活着的感觉」，差异已记录在 AI-PROJECT-GUIDE §4.1）。
 * 数据源变更时对照 AgentAtelierR 重新核对，不要凭记忆改。 */
;(function (root) {
  // 11 个语义标签（CharacterAction 枚举去掉 none）→ 中文语义（写提示词/日志用）
  root.SPINE_ACTION_TAGS = {
    acknowledge: '认同、附和',
    disagree: '不同意、否定',
    think: '思考、犹豫',
    explain: '解释、说明',
    excited: '兴奋、开心',
    wave: '挥手、打招呼',
    shy: '害羞、不好意思',
    surprised: '惊讶、吓一跳',
    comfort: '安慰、亲近',
    playful: '俏皮、卖萌',
    invite: '邀请、欢迎'
  }

  root.SPINE_ACTION_PLANS = {
    // 坐姿计划（_seatedActionPlans）
    sit: {
      acknowledge: { groups: [], oneShot: 'motion_oneshot_D_001_active' },
      disagree: { groups: [], oneShot: 'motion_oneshot_D_003_active' },
      think: { groups: ['grp_fg_106', 'grp_fg_023'], oneShot: 'motion_oneshot_D_010_active' },
      explain: { groups: ['grp_fg_021', 'grp_fg_121', 'grp_fg_221'], oneShot: 'motion_oneshot_D_009_active' },
      excited: { groups: ['grp_fg_030'], oneShot: 'motion_oneshot_D_002_active' },
      wave: { groups: ['grp_fg_033', 'grp_fg_028'] },
      shy: { groups: ['grp_fg_111', 'grp_fg_107'] },
      surprised: { groups: ['grp_fg_029'], oneShot: 'motion_oneshot_D_011_active' },
      comfort: { groups: ['grp_fg_031'] },
      playful: { groups: ['grp_fg_016'] },
      invite: { groups: ['grp_fg_031'] }
    },
    // 站姿计划（_standingActionPlans；注意站姿 FG 编号与坐姿含义不同，勿混用）
    stand: {
      acknowledge: { groups: [], oneShot: 'motion_oneshot_D_001_active' },
      disagree: { groups: [], oneShot: 'motion_oneshot_D_003_active' },
      think: { groups: ['grp_fg_002', 'grp_fg_g_009'], oneShot: 'motion_oneshot_D_010_active' },
      explain: { groups: ['grp_fg_g_007'], oneShot: 'motion_oneshot_D_009_active' },
      excited: { groups: ['grp_fg_003'], oneShot: 'motion_oneshot_D_002_active' },
      wave: { groups: ['grp_fg_g_004', 'grp_fg_f_004', 'grp_fg_003'] },
      shy: { groups: ['grp_fg_004', 'grp_fg_g_008'] },
      surprised: { groups: ['grp_eh_61'], oneShot: 'motion_oneshot_D_011_active' },
      comfort: { groups: ['grp_fg_g_007'] },
      playful: { groups: ['grp_fg_g_006', 'grp_fg_g_009'] },
      invite: { groups: ['grp_fg_g_007'] }
    }
  }
})(typeof window !== 'undefined' ? window : globalThis)
