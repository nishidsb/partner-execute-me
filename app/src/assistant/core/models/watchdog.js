/**
 * 0.46.21 LLM 看门狗：provider 里的 fetch 是裸跑（session 传 signal: null），
 * 流式连接一旦停摆（不吐数据也不断开——DeepSeek 高峰期实测会发生），
 * reader.read() 永远 pending → 整轮对话永久挂死，聊天窗输入被
 * 「◇ 正在使用 pet_say…」卡住（真机 11-03 17:31 实锤，卡了 8 分钟直到重启）。
 *
 * 策略：首包 60s；之后每收到一块数据重置一次 120s 空闲计时；
 * 调用方自己传了 signal 也接进来（外部断 → 内部跟着断）。
 */
export function chatWatchdog (outerSignal, { firstMs = 60000, idleMs = 120000 } = {}) {
  const ctrl = new AbortController()
  let fired = false
  let timer = setTimeout(onFire, firstMs)
  function onFire () {
    if (fired) return
    fired = true
    try { ctrl.abort() } catch { }
  }
  function onTouch () {
    clearTimeout(timer)
    timer = setTimeout(onFire, idleMs)
  }
  function onOuter () { onFire() }
  if (outerSignal) {
    if (outerSignal.aborted) onFire()
    else {
      try { outerSignal.addEventListener('abort', onOuter, { once: true }) } catch { }
    }
  }
  return {
    signal: ctrl.signal,
    /** 收到数据后调用：重置空闲计时 */
    touch: onTouch,
    done () {
      clearTimeout(timer)
      if (outerSignal) {
        try { outerSignal.removeEventListener('abort', onOuter) } catch { }
      }
    },
    /** 是否因超时触发（用于把 AbortError 翻译成人话） */
    fired: () => fired
  }
}
