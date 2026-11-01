/* 用真实 three.js 复现 vrm-stage 的相机与朝向，判定「往右走时脸朝屏幕哪边」。
 * 用完即删的临时验证脚本。 */
const THREE = require('three')

const canvasW = 300, canvasH = 520
const camera = new THREE.PerspectiveCamera(30, canvasW / canvasH, 0.1, 100)
// 复现 fit()：camera.position.set(center.x, center.y, center.z - dist); lookAt(center)
const center = new THREE.Vector3(0, 0.8, 0)
const dist = 5
camera.position.set(center.x, center.y, center.z - dist)
camera.lookAt(center.x, center.y, center.z)
camera.updateMatrixWorld()

/** 世界坐标点 → 屏幕坐标（NDC，x>0 = 屏幕右半边） */
function ndcX (v) {
  const p = v.clone().project(camera)
  return p.x
}

/** 模型 root.rotation.y=θ 后，可见正面指向的世界向量。
 * 约束来源：idle 时 root.rotation.y=Math.PI 用户看到的是正脸 → 正面世界朝向 = -Z（朝相机）。 */
function frontWorld (theta) {
  return new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), theta)
}

// 第 0 步：确认「屏幕右 = 哪个世界方向」——在模型两侧各放一个点看投影
console.log('[0] 世界 +X 投影 NDC.x =', ndcX(new THREE.Vector3(1, 0.8, 0)).toFixed(3),
  '；世界 -X 投影 NDC.x =', ndcX(new THREE.Vector3(-1, 0.8, 0)).toFixed(3))
console.log('    → NDC.x>0 是屏幕右半边，所以「屏幕右」= 世界',
  ndcX(new THREE.Vector3(1, 0.8, 0)) > 0 ? '+X' : '-X')

for (const [label, theta] of [
  ['idle（base=π）', Math.PI],
  ['dir=1 旧代码 π+π/2', Math.PI + Math.PI / 2],
  ['dir=1 新代码 π-π/2', Math.PI - Math.PI / 2],
  ['dir=-1 旧代码 π-π/2', Math.PI - Math.PI / 2],
  ['dir=-1 新代码 π+π/2', Math.PI + Math.PI / 2]
]) {
  const f = frontWorld(theta)
  // 从模型中心沿正面探出 0.5 米的点，看它落在屏幕左半还是右半
  const probe = new THREE.Vector3(0, 0.8, 0).addScaledVector(f, 0.5)
  const x = ndcX(probe)
  console.log(`[${label}] θ=${theta.toFixed(3)} 正面世界向量=(${f.x.toFixed(2)},0,${f.z.toFixed(2)}) → 脸指向屏幕${x > 0 ? '右' : '左'} (NDC.x=${x.toFixed(3)})`)
}
