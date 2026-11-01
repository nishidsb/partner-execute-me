'use strict'
/* 打包 AI 伴侣渲染层用的第三方库（开源版：three + three-vrm，不含 Spine）
   产物 src/renderer/companion/libs.js（IIFE，暴露 window.AuraLibs）
   用法: node tools/build-companion-libs.public.js
   持有 Spine 授权请改用 build-companion-libs.js（完整版，含 spine-canvas/webgl） */
const esbuild = require('esbuild')
const path = require('path')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'companion-libs-entry.public.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  outfile: path.join(__dirname, '..', 'src', 'renderer', 'companion', 'libs.js'),
  logLevel: 'info'
})
