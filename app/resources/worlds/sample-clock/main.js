/**
 * 示例 World 扩展入口（CommonJS）。
 * 契约：module.exports = { tools?, api?, onEnable?, onDisable? }
 *  - tools：注册进模型的工具表（名字自动加 w_<id>_ 前缀）
 *  - api：面板 window.worldApi.invoke(fn, args) 能调到的函数
 *  - onEnable(ctx)：装载/改配置时调用；ctx = { config, dataDir, log }
 */
let tzOffset = 8

module.exports = {
  tools: [
    {
      name: 'now_time',
      description: '看当前的准确时间（日期 + 星期 + 时分秒）',
      parameters: { type: 'object', properties: {} },
      risk: 'low',
      exec: () => {
        const d = new Date(Date.now() + (tzOffset - -new Date().getTimezoneOffset() / 60) * 3600 * 1000)
        const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
        return {
          time: d.toISOString().slice(0, 19).replace('T', ' '),
          weekday: '星期' + week
        }
      }
    }
  ],
  api: {
    now: () => ({ iso: new Date().toISOString(), tzOffset })
  },
  onEnable (ctx) {
    tzOffset = Number(ctx.config && ctx.config.tzOffset) || 8
    ctx.log('示例时钟已启用（时区 ' + tzOffset + '）')
  },
  onDisable () { }
}
