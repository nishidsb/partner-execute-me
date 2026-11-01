/** Ryza Assistant 入口：node src/index.js（或 npm start） */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDataDir } from './config.js'
import { initLogger, logger } from './logger.js'
import { startRepl } from './cli/repl.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 数据目录可用 RYZA_DATA_DIR 重定向（测试隔离用）
initDataDir(process.env.RYZA_DATA_DIR || path.join(ROOT, 'data'))
initLogger(process.env.RYZA_DATA_DIR ? path.join(process.env.RYZA_DATA_DIR, '..', 'logs') : path.join(ROOT, 'logs'))

process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err && err.stack))
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err && err.stack))

logger.info('启动 Ryza Assistant，数据目录:', process.env.RYZA_DATA_DIR || path.join(ROOT, 'data'))
startRepl()
