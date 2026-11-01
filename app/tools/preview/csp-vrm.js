  const q = new URLSearchParams(location.search)
  const done = (o) => { window.__probe = o; document.title = o.ok ? 'OK' : 'ERR' }
  try {
    const st = window.AuraVrm.create({
      canvas: document.getElementById('c'),
      libs: window.AuraLibs,
      url: q.get('model'),
      sig: 'probe',
      fps: 30,
      restFps: 15,
      isBusy: () => false
    })
    st.ready.then(() => {
      const THREE = window.AuraLibs.THREE
      let total = 0, withMap = 0, inst = 0
      st.root.updateMatrixWorld(true)
      st.root.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (!m) continue
          inst++
          total++
          if (m.map) withMap++
        }
      })
      const dbg = (() => {
        const v = st.vrm
        if (!v) return 'no-vrm'
        const h = v.humanoid
        const r = {
          meta: v.meta && (v.meta.metaVersion || v.meta.specVersion),
          hasHumanoid: !!h,
          hasNorm: !!(h && h.getNormalizedBoneNode),
          mixer: !!st.mixer
        }
        if (h && h.getNormalizedBoneNode) {
          r.hips = !!h.getNormalizedBoneNode('hips')
          r.leg = !!h.getNormalizedBoneNode('leftUpperLeg')
          r.rawLeg = !!(h.getRawBoneNode && h.getRawBoneNode('leftUpperLeg'))
        }
        try { const inn = st.state || {}; r.rigKeys = inn.rig ? Object.keys(inn.rig).length : -1; r.rigDebug = inn.rigDebug } catch { r.rigKeys = 'err' }
        return r
      })()
      const only = q.get('only')
      let hiddenN = 0
      if (only) {
        const THREE2 = window.AuraLibs.THREE
        st.root.traverse((o) => {
          if (!o.isMesh && !o.isSkinnedMesh) return
          if (only === 'hat') {
            const mn = o.material && String(o.material.name || '')
            o.visible = mn.includes('CapShape')
            if (!o.visible) hiddenN++
          } else if (only === 'head') {
            const bb = new THREE2.Box3().setFromObject(o)
            o.visible = bb.min.y > 1.25; if (!o.visible) hiddenN++
          } else {
            o.visible = String(o.name).includes(only)
          }
        })
      }
      const namesList = []
      st.root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && namesList.length < 30) namesList.push(o.name + '|' + (o.material && o.material.name)) })
      const b = new THREE.Box3().setFromObject(st.root)
      window.__shot = document.getElementById('c').toDataURL('image/png')
      // 呼吸/待机量化：rig 有没有建起来、一秒后骨骼角度变了多少（"不会动"必须用数字说话）
      const inner = st.state || {}
      const rig = inner.rig || null
      const names = rig ? Object.keys(rig) : []
      const snap = () => {
        const o = {}
        for (const n of names) { const r = rig[n].rotation; o[n] = [r.x, r.y, r.z] }
        return o
      }
      // 延迟一点再摆姿势：让 fit() 先按站姿缓存包围盒（跟真实使用顺序一致）
      if (q.get('pose') && st.setPose) setTimeout(() => st.setPose(q.get('pose')), 400)
      const walk = q.get('walk')
      if (walk) {
        st.setWalk(true, Number(q.get('dir') || 1), 60)
        setTimeout(() => { window.__shot = null }, 0)
      }
      const a0 = snap()
      setTimeout(() => {
        const a1 = snap()
        let maxDeg = 0
        let which = ''
        for (const n of names) {
          const d = Math.max(
            Math.abs(a1[n][0] - a0[n][0]),
            Math.abs(a1[n][1] - a0[n][1]),
            Math.abs(a1[n][2] - a0[n][2])
          )
          if (d > maxDeg) { maxDeg = d; which = n }
        }
        window.__shot2 = document.getElementById('c').toDataURL('image/png')
        done({ ok: withMap > 0, mats: inst, withMap, kind: st.vrm ? 'vrm' : 'glb',
               height: Math.round((b.max.y - b.min.y) * 1000) / 1000,
               dbg, namesList, only, hiddenN,
               rigBones: names.length, droop: Math.round((inner.droop || 0) * 1000) / 1000, posed: !!inner.rig,
               idleMaxDeg: Math.round(maxDeg * 180 / Math.PI * 100) / 100, idleBone: which })
      }, Number(q.get('wait') || 1000))
    }).catch((e) => done({ ok: false, err: String((e && e.message) || e) }))
  } catch (e) { done({ ok: false, err: String((e && e.message) || e) }) }
