// Tiny synthesized ui sounds (web audio, no files). Quiet by design, toggled in the footer.
let ctx
let on = true
try { on = localStorage.getItem('sound') !== 'off' } catch {}
export const soundOn = () => on
export function setSound(v) {
  on = v
  try { localStorage.setItem('sound', v ? 'on' : 'off') } catch {}
}

function tone(freq, { at = 0, dur = 0.08, type = 'sine', vol = 0.04, to } = {}) {
  ctx ||= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  const t = ctx.currentTime + at
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(ctx.destination)
  o.start(t)
  o.stop(t + dur + 0.02)
}

const play = (f) => () => {
  if (!on) return
  try { f() } catch {}
}
export const sfx = {
  tap: play(() => tone(540, { to: 720, dur: 0.045, vol: 0.03, type: 'triangle' })),
  open: play(() => tone(320, { to: 560, dur: 0.12, vol: 0.025 })),
  success: play(() => [523.25, 659.25, 783.99].forEach((f, i) => tone(f, { at: i * 0.075, dur: 0.24, vol: 0.04, type: 'triangle' }))),
  error: play(() => { tone(260, { dur: 0.1, vol: 0.03, type: 'sawtooth', to: 200 }); tone(200, { at: 0.09, dur: 0.16, vol: 0.03, type: 'sawtooth', to: 140 }) }),
}
