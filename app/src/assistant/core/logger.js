/** 简单分级日志：控制台 + logs/ryza.log（敏感信息一律不打） */
import fs from 'node:fs'
import path from 'node:path'

let level = (process.env.RYZA_LOG || 'info').toLowerCase()
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
let logDir = path.join(process.cwd(), 'logs')
let stream = null

export function initLogger (dir) {
  logDir = dir
  fs.mkdirSync(dir, { recursive: true })
  stream = fs.createWriteStream(path.join(dir, 'ryza.log'), { flags: 'a' })
}

function write (lv, args) {
  if (LEVELS[lv] < LEVELS[level]) return
  const line = `[${new Date().toISOString()}] [${lv.toUpperCase()}] ` + args.map((a) =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')
  if (lv === 'error') console.error(line)
  else if (lv === 'warn') console.warn(line)
  else console.log(line)
  if (stream) stream.write(line + '\n')
}

export const logger = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  setLevel: (l) => { if (LEVELS[l]) level = l }
}
