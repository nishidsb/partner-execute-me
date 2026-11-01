'use strict'
/**
 * 新增采集面的解析器测试（2026-10-28 补：Steam 时长 / 最近打开 / 设备运行时间 / 已装程序）
 *
 * 为什么只测解析不测采集：这些数据源（localconfig.vdf、事件日志、注册表）在 CI/沙箱里
 * 要么没有、要么被安全策略挡住。把「读取」和「解析」分开，解析用固定样本锁死，
 * 读取在真机上失败也只是少一块数据，不会把别的带崩。
 */
const test = require('node:test')
const assert = require('node:assert')

const steam = require('../src/main/profile/steam')
const opened = require('../src/main/profile/opened')
const sessions = require('../src/main/profile/sessions')
const apps = require('../src/main/profile/apps')

/* ---------------- Steam 游玩时长 ---------------- */

const VDF = `"UserLocalConfigStore"
{
	"Software"
	{
		"valve"
		{
			"steam"
			{
				"Apps"
				{
					"1449850"
					{
						"LastPlayed"		"1745498519"
						"Playtime"		"930"
						"Playtime2wks"		"6"
					}
					"440"
					{
						"LastPlayed"		"1700000000"
						"Playtime"		"12"
					}
					"760"
					{
						"Playtime2wks"		"0"
					}
				}
			}
		}
	}
}`

test('steam：解析 localconfig（小写 valve/steam 也要认）', () => {
  const r = steam.parseLocalConfig(VDF)
  assert.equal(r['1449850'].minutes, 930)
  assert.equal(r['1449850'].lastPlayed, 1745498519)
  assert.equal(r['440'].minutes, 12)
  assert.equal(r['760'], undefined)   // 只有 2wks 没有总时长的跳过
})

test('steam：VDF 词法容忍制表符、转义引号、嵌套', () => {
  const t = steam.tokenize('"a"\n{\n\t"b"\t\t"c\\\\d"\n}\n')
  assert.deepEqual(t, ['a', '{', 'b', 'c\\d', '}'])
  const obj = steam.parseVdf('"x" { "y" { "z" "1" } }')
  assert.equal(obj.x.y.z, '1')
})

test('steam：没装 Steam 时返回空而不是抛错', () => {
  const r = steam.collect({ roots: [] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.games, [])
})

/* ---------------- 最近打开过的文件 ---------------- */

test('opened：扩展名归类，.lnk 要去掉再看', () => {
  assert.equal(opened.kindOf('影片.mp4.lnk'), 'video')
  assert.equal(opened.kindOf('简历.pdf'), 'doc')
  assert.equal(opened.kindOf('截图 2026-10-25.png'), 'image')
  assert.equal(opened.kindOf('某个文件夹.lnk'), '')   // 目录不算
  assert.equal(opened.kindOf('config.json'), 'code')
})

test('opened：VLC 的 file:/// 最近列表能剥出来', () => {
  const ini = [
    '[RecentsMRL]',
    'list=file:///C:/Users/x/Videos/a%20b.mp4,file:///D:/x/c.mkv',
    '[other]',
    'list=file:///C:/nope.txt'
  ].join('\n')
  const rows = opened.parseVlcIni(ini)
  assert.deepEqual(rows.map((r) => r.name), ['a b.mp4', 'c.mkv'])
  assert.ok(rows.every((r) => r.kind === 'video'))
})

test('opened：PotPlayer 的 ini 里满篇路径也能挑出媒体文件', () => {
  const ini = [
    '[Recent]',
    '0=C:\\Videos\\鬼灭 第1集.mkv',
    '1=D:\\片子\\note.txt',
    '2=D:\\片子\\音乐.flac'
  ].join('\n')
  const rows = opened.parsePotPlayerIni(ini)
  assert.deepEqual(rows.map((r) => r.name), ['鬼灭 第1集.mkv', '音乐.flac'])
})

/* ---------------- 设备运行时间 ---------------- */

const EVT = (time, id, provider) =>
  '<Event xmlns="x"><System><Provider Name=\'' + provider + '\'/>' +
  '<EventID>' + id + '</EventID><TimeCreated SystemTime=\'' + time + '\'/></System></Event>'

test('sessions：只认 Kernel-General 的 12/13，别的事件不算', () => {
  const xml = [
    EVT('2026-10-28T01:00:00.000Z', 12, 'Microsoft-Windows-Kernel-General'),
    EVT('2026-10-28T09:00:00.000Z', 13, 'Microsoft-Windows-Kernel-General'),
    EVT('2026-10-28T03:00:00.000Z', 12, 'Microsoft-Windows-UserModePowerService'),
    EVT('2026-10-28T04:00:00.000Z', 6005, 'EventLog')
  ].join('')
  const rows = sessions.parseEventsXml(xml)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.type), ['boot', 'shutdown'])
})

test('sessions：配段（开机→关机 / 断电没关机记录 / 还在跑）', () => {
  const H = 3600000
  const t0 = Date.UTC(2026, 9, 28, 2, 0, 0)
  const rows = sessions.pairSessions([
    { type: 'boot', at: t0 },
    { type: 'shutdown', at: t0 + 10 * H },
    { type: 'boot', at: t0 + 12 * H },
    { type: 'boot', at: t0 + 20 * H },              // 上一个没关机（断电/强制重启）
    { type: 'shutdown', at: t0 + 26 * H }
  ], t0 + 26 * H)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].hours, 10)
  assert.equal(rows[1].abnormal, true)
  assert.equal(rows[2].hours, 6)
})

test('sessions：读不到事件日志时只报本次运行时长，不编历史', () => {
  const r = sessions.collect({ usage: null, days: 14 })
  assert.equal(typeof r.uptimeHours, 'number')
  if (r.source === 'none') assert.deepEqual(r.sessions, [])
})

/* ---------------- 已装程序 ---------------- */

const REG = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1}',
  '    DisplayName    REG_SZ    Blender',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{2}',
  '    DisplayName    REG_SZ    Microsoft Visual C++ 2015-2022 Redistributable (x64)',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{3}',
  '    DisplayName    REG_SZ    Update for Microsoft Edge',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{4}',
  '    DisplayName    REG_SZ    剪映',
  ''
].join('\r\n')

test('apps：只取 DisplayName，且把补丁/运行库折叠掉', () => {
  const names = apps.parseRegQuery(REG)
  assert.equal(names.length, 4)
  const keep = names.filter((n) => !apps.NOISE.test(n))
  assert.deepEqual(keep, ['Blender', '剪映'])
})
