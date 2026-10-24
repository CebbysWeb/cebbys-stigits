/**
 * Small, soft sound effects made with Web Audio, so there are no files to load.
 * Browsers only allow audio after the player interacts, so the context starts on
 * the first pointer or key press.
 */
let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = true

function unlock(): void {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
}
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, unlock, { capture: true })

export function setSoundOn(on: boolean): void {
  enabled = on
}

const ready = (): AudioContext | null => (enabled && ctx && ctx.state === 'running' ? ctx : null)

/** One note: a quick attack, then an exponential fade. */
function tone(ac: AudioContext, freq: number, at: number, length: number, volume: number, type: OscillatorType = 'sine', endFreq = freq): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(endFreq, at + length)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(gain).connect(master!)
  osc.start(at)
  osc.stop(at + length + 0.02)
}

/** A stick is moved: a soft wooden tock, varied a little so repeats don't drone. */
export function playMove(): void {
  const ac = ready()
  if (!ac) return
  const now = ac.currentTime
  const pitch = 520 + Math.random() * 80
  tone(ac, pitch, now, 0.09, 0.35, 'triangle', pitch * 0.6)
  tone(ac, pitch * 2.4, now, 0.04, 0.08, 'sine')
}

/** A chat message arrives: one quiet, short blip. */
export function playChat(): void {
  const ac = ready()
  if (!ac) return
  tone(ac, 1046.5, ac.currentTime, 0.18, 0.08)
}

/** Time is running out: a dry tick, sharper for the last few seconds. */
export function playTick(urgent: boolean): void {
  const ac = ready()
  if (!ac) return
  tone(ac, urgent ? 1400 : 1000, ac.currentTime, 0.06, urgent ? 0.22 : 0.14, 'square', urgent ? 1100 : 800)
}

/** It's my turn: a gentle rising two-note chime. */
export function playMyTurn(): void {
  const ac = ready()
  if (!ac) return
  const now = ac.currentTime
  // A5 then E6 (a fifth up), each with a faint octave for a bell-like ring.
  for (const [freq, at] of [[880, 0], [1318.5, 0.14]]) {
    tone(ac, freq, now + at, 0.7, 0.18)
    tone(ac, freq * 2, now + at, 0.35, 0.04)
  }
}
