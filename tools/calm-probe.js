// Paste into the Claude Code webview DevTools console, with the console context set to the
// hidden `about:srcdoc` iframe (the one that rasterizes Svg frames).
// Logs every frame that took over 100 ms: the editor freezes a mod's animations once a tick does.
//   ms    = from the editor posting the frame until it was drawn (includes waiting)
//   ownMs = drawing only
//   lag   = ms - ownMs (time spent waiting before the draw started)
(() => {
  if (typeof port === 'undefined' || typeof now !== 'function') return console.error('Wrong context: pick the about:srcdoc iframe in the console context menu')
  const s = window.__calm = { start: new Date().toLocaleTimeString(), ticks: 0, loads: 0, slow: [], maxOwn: 0, maxLag: 0, lastTick: 0, gaps: [] }
  const send = port.postMessage.bind(port)
  const ticking = new Set()
  const recv = port.onmessage
  port.onmessage = ev => {
    const j = ev.data
    if (j && j.id !== undefined && j.drop === undefined) {
      if (j.src === undefined) { s.ticks++; ticking.add(j.id)
        const t = performance.now()
        if (s.lastTick && t - s.lastTick > 2000) s.gaps.push({ at: new Date().toLocaleTimeString(), gapMs: Math.round(t - s.lastTick) })
        s.lastTick = t
      } else s.loads++
    }
    recv(ev)
  }
  port.postMessage = (m, tr) => {
    if (m && m.state === 'ended') {
      const lag = m.ms - m.ownMs, tick = ticking.delete(m.id)
      s.maxOwn = Math.max(s.maxOwn, Math.round(m.ownMs)); s.maxLag = Math.max(s.maxLag, Math.round(lag))
      if (m.ms > 100) {
        const row = { at: new Date().toLocaleTimeString(), tick, ms: Math.round(m.ms), ownMs: Math.round(m.ownMs), lag: Math.round(lag) }
        s.slow.push(row); console.warn('[calm-probe] slow', row)
      }
    }
    return send(m, tr)
  }
  window.calmReport = () => { console.log(`since ${s.start} · ticks ${s.ticks} · loads ${s.loads} · maxOwn ${s.maxOwn} · maxLag ${s.maxLag}`); console.table(s.slow); console.table(s.gaps) }
  console.log('[calm-probe] attached · run calmReport() for results')
})()
