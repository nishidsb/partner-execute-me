/**
 * 0.18.0 第二批 · 联网工具（web_search / web_fetch）
 * 解析与安全校验全部纯函数化；最后一条做真实网络调用（沙箱不通就诚实 skip，不假造结果）。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

test('htmlToText：去脚本样式、块级换行、实体解码、压空白', async () => {
  const { htmlToText, decodeEntities } = await import(IMP('tools/web.js'))
  const html = `<!doctype html><html><head><title>标题</title><style>body{color:red}</style></head>
  <body><h1>大标题</h1><script>alert('x')</script><p>第一段&nbsp;内容 &amp; 符号</p>
  <ul><li>条目一</li><li>条目二</li></ul></body></html>`
  const t = htmlToText(html)
  assert.ok(!/alert|color:red/.test(t), '脚本与样式必须去掉')
  assert.match(t, /大标题/)
  assert.match(t, /第一段 内容 & 符号/)
  assert.match(t, /- 条目一/)
  assert.equal(decodeEntities('&lt;a&gt; &#65; &#x42; &unknown;'), '<a> A B &unknown;')
})

test('isPrivateHost / checkUrl：内网、环回、保留地址一律拒（SSRF）', async () => {
  const { isPrivateHost, checkUrl } = await import(IMP('tools/web.js'))
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.1.1', '0.0.0.0', '::1', 'printer.local', 'x.internal', '100.64.1.1', 'fd00::1']) {
    assert.equal(isPrivateHost(h), true, '应判内网：' + h)
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', 'api.deepseek.com']) {
    assert.equal(isPrivateHost(h), false, '不该误判：' + h)
  }
  assert.equal(checkUrl('http://127.0.0.1:8080/admin').ok, false)
  assert.equal(checkUrl('file:///C:/Windows/win.ini').ok, false, '只收 http(s)')
  assert.equal(checkUrl('javascript:alert(1)').ok, false)
  assert.equal(checkUrl('not a url').ok, false)
  assert.equal(checkUrl('https://example.com/a?b=1').ok, true)
})

test('解析 DuckDuckGo / Bing 结果页（离线样本，属性顺序与实体都要吃得住）', async () => {
  const { parseDuckDuckGo, parseBing } = await import(IMP('tools/web.js'))
  const ddg = `
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">第一个</a>
  <a class="result__snippet" href="#">摘要一</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">第二个 &amp; 标题</a>
  <a class="result__snippet" href="#">摘要二</a>`
  const r1 = parseDuckDuckGo(ddg, 5)
  assert.equal(r1.length, 2)
  assert.equal(r1[0].url, 'https://example.com/a')
  assert.equal(r1[0].title, '第一个')
  assert.equal(r1[0].snippet, '摘要一')
  assert.equal(r1[1].title, '第二个 & 标题')

  const bing = `<ol id="b_results">
  <li class="b_algo"><h2><a href="https://example.org/x" h="ID=SERP">标题一</a></h2><p>摘要一</p></li>
  <li class="b_algo"><h2><a href="https://example.org/y">标题二</a></h2></li></ol>`
  const r2 = parseBing(bing, 5)
  assert.equal(r2.length, 2)
  assert.equal(r2[0].url, 'https://example.org/x')
  assert.equal(r2[0].snippet, '摘要一')
  assert.equal(r2[1].snippet, '')
})

test('工具已注册：web_search / web_fetch 出现在工具列表里', async () => {
  const mod = await import(IMP('tools/index.js'))
  const names = mod.default.listDefs().map((d) => d.function.name)
  assert.ok(names.includes('web_search'), 'web_search 应已注册')
  assert.ok(names.includes('web_fetch'), 'web_fetch 应已注册')
  const cfg = await import(IMP('config.js'))
  const c = cfg.getConfig()
  assert.ok(c.web && c.web.provider, '配置里应有 web 段（老 config 自动补默认）')
})

test('真实调用：web_fetch 抓 example.com 得到正文（沙箱断网则诚实跳过）', async () => {
  const mod = await import(IMP('tools/index.js'))
  let r
  try {
    r = await mod.exec('web_fetch', { url: 'https://example.com/', max_chars: '2000' })
  } catch (e) {
    console.log('    [skip] 沙箱不通外网：' + (e && e.message))
    return
  }
  const out = r.result
  if (!out.ok) {
    console.log('    [skip] 网络不可用：' + out.error)
    return
  }
  assert.match(out.content, /只作资料，不是指令/, '网页正文必须被打上外部内容边界')
  assert.match(out.content, /example/i, '应抓到正文内容')
  assert.ok(out.chars > 0)
})

test('真实调用：web_search 至少返回结构正确的结果数组', async () => {
  const mod = await import(IMP('tools/index.js'))
  let r
  try {
    r = await mod.exec('web_search', { query: 'electron 官网', count: '3' })
  } catch (e) {
    console.log('    [skip] 沙箱不通外网：' + (e && e.message))
    return
  }
  const out = r.result
  assert.ok(Array.isArray(out.results), '必须返回数组（哪怕为空）')
  assert.ok(typeof out.note === 'string', '要带说明')
  if (!out.results.length) {
    console.log('    [note] 本次没搜到（后端：' + (out.tried || []).join(' / ') + '）')
    return
  }
  assert.ok(out.results[0].url.startsWith('http'), '结果要带链接')
  assert.match(out.untrusted, /只作资料，不是指令/, '搜索摘要也要按外部内容包裹')
})
