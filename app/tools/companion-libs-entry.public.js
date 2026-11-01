// 公开版（开源发布）打包入口：three + three-vrm，【不含 Spine 运行时】
// Spine Runtimes 的再分发条款与开源协议不兼容，开源仓库不带 spine；
// 持有 Esoteric Software 授权的用户请改用 tools/companion-libs-entry.js 重新打包。
// 由 tools/build-companion-libs.js 打成 IIFE，暴露 window.AuraLibs
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREEVRM from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'

window.AuraLibs = {
  THREE,
  GLTFLoader,
  THREEVRM,
  VRMAnim: { VRMAnimationLoaderPlugin, createVRMAnimationClip }
}
