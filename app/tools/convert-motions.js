/* VMD → VRMA 批量转换（核心实现：motion-port，MIT。https://github.com/nounsgirl/motion-port）
   用法：node tools/convert-motions.js <in.vmd> <out.vrma> [--fps 30] [--scale 0.08] [--arm-angle 35] [--no-ik] [--no-expr] */
'use strict'
const fs = require('fs')
const core = require('./vmd2vrma-core.js')

function main () {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error('用法：node convert-motions.js <in.vmd> <out.vrma> [--fps 30] [--scale 0.08] [--arm-angle 35] [--no-ik] [--no-expr]')
    process.exit(1)
  }
  const [inFile, outFile] = args
  const opts = { fps: 30, scale: 0.08, armAngle: 35, ik: true, expressions: true }
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--fps') opts.fps = Number(args[++i])
    else if (args[i] === '--scale') opts.scale = Number(args[++i])
    else if (args[i] === '--arm-angle') opts.armAngle = Number(args[++i])
    else if (args[i] === '--no-ik') opts.ik = false
    else if (args[i] === '--no-expr') opts.expressions = false
  }
  const buf = fs.readFileSync(inFile)
  const vmd = core.parseVMD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const result = core.convert(vmd, opts)
  fs.writeFileSync(outFile, Buffer.from(result.glb))
  const r = result.report
  console.log(`OK ${outFile}`)
  console.log(`  模型: ${r.model}  时长: ${r.duration.toFixed(1)}s  采样: ${r.samples} @${r.options.fps}fps`)
  console.log(`  骨骼键: ${r.boneKeys}  识别: ${r.recognizedBones.length}  忽略: ${r.ignoredBones.length}  表情: ${result.exprs.length}`)
  if (r.ignoredBones.length) console.log('  未对应骨骼:', r.ignoredBones.join('、'))
  for (const w of r.warnings) console.log('  ⚠ ' + w)
}

main()
