import type { Lang } from '../i18n'
import { DEFAULT_SETTINGS, type Settings } from '../engine/game'

/** What this device remembers between visits: the player's name and colour, and the host's table settings. */
export interface Profile {
  name: string
  /** Hue 0–360, saturation and value 0–1 (HSV, as picked on the wheel and shade bar). */
  h: number
  s: number
  v: number
  /** Chosen language; unset means follow the browser. */
  lang?: Lang
}

const PROFILE_KEY = 'stigits-profile'
const SETTINGS_KEY = 'stigits-settings'

function read<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<T>
  } catch {
    return {}
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode): nothing is remembered */
  }
}

export function loadProfile(): Profile {
  const p = read<Profile>(PROFILE_KEY)
  // First visit: keep a name typed before profiles existed, and pick a random colour.
  let legacy = ''
  try {
    legacy = localStorage.getItem('stigits-name') ?? ''
  } catch {
    /* ignore */
  }
  return { name: p.name ?? legacy, lang: p.lang, h: p.h ?? Math.floor(Math.random() * 360), s: p.s ?? 0.8, v: p.v ?? 0.9 }
}

export const saveProfile = (p: Profile): void => write(PROFILE_KEY, p)

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read<Settings>(SETTINGS_KEY) }
}

export const saveSettings = (s: Settings): void => write(SETTINGS_KEY, s)

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
  }
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export const profileColor = (p: Profile): string => hsvToHex(p.h, p.s, p.v)

/** A random, clearly coloured hex for a bot. */
export const randomColor = (): string => hsvToHex(Math.random() * 360, 0.65 + Math.random() * 0.3, 0.75 + Math.random() * 0.2)

/** Markup for the colour wheel (hue around, saturation outwards) and the shade bar beside it. */
export function colorPickerHtml(p: Profile, label: string): string {
  const angle = (p.h * Math.PI) / 180
  return `<div class="color-picker">
    <div class="wheel" data-picker="wheel" style="--v: ${p.v}">
      <span class="wheel-dot" style="left: ${50 + Math.cos(angle) * p.s * 50}%; top: ${50 + Math.sin(angle) * p.s * 50}%"></span>
    </div>
    <div class="shade" data-picker="shade" style="--pure: ${hsvToHex(p.h, p.s, 1)}">
      <span class="shade-dot" style="top: ${(1 - p.v) / 0.8 * 100}%"></span>
    </div>
    <div class="swatch-col"><span class="swatch" style="background: ${profileColor(p)}"></span><small>${label}</small></div>
  </div>`
}

/**
 * Drives a picker rendered by colorPickerHtml inside `root`: dragging the wheel
 * picks hue and saturation, the bar picks how dark. Updates the DOM directly and
 * calls `change` as the colour moves.
 */
export function bindColorPicker(root: HTMLElement, p: Profile, change: (p: Profile) => void): void {
  const wheel = root.querySelector<HTMLElement>('[data-picker=wheel]')
  const shade = root.querySelector<HTMLElement>('[data-picker=shade]')
  if (!wheel || !shade) return
  const paint = () => {
    const angle = (p.h * Math.PI) / 180
    const dot = wheel.querySelector<HTMLElement>('.wheel-dot')!
    dot.style.left = `${50 + Math.cos(angle) * p.s * 50}%`
    dot.style.top = `${50 + Math.sin(angle) * p.s * 50}%`
    wheel.style.setProperty('--v', String(p.v))
    shade.style.setProperty('--pure', hsvToHex(p.h, p.s, 1))
    shade.querySelector<HTMLElement>('.shade-dot')!.style.top = `${((1 - p.v) / 0.8) * 100}%`
    root.querySelector<HTMLElement>('.swatch')!.style.background = profileColor(p)
    change(p)
  }
  const track = (el: HTMLElement, at: (e: PointerEvent, r: DOMRect) => void) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        at(ev, el.getBoundingClientRect())
        paint()
      }
      move(e)
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true })
    })
  }
  track(wheel, (e, r) => {
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    p.h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
    p.s = Math.min(1, Math.hypot(x, y) * 2)
  })
  // Value runs from full brightness at the top to quite dark (0.2) at the bottom.
  track(shade, (e, r) => {
    p.v = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 0.8
  })
}
