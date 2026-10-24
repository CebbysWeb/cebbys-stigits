import { cardSvg } from './svg'

interface Slot {
  x: number
  y: number
  angle: number
}

/**
 * The local player's hand as a fanned, animated row of cards. The element and
 * its card nodes persist across renders so CSS transitions can animate dealing,
 * playing and reordering. Players drag cards sideways to rearrange them; the
 * order is local to this browser.
 */
export interface HandOptions {
  /** Whether the player can drag cards to reorder them. */
  interactive: boolean
  minCard: number
  maxCard: number
  /** Called when the player drags a card up out of the hand to play it. */
  onPlay?: (card: number) => void
  /** Show card backs instead of shapes (other players' hands). */
  faceDown?: boolean
}

/** How far (px) a card must be dragged upwards to play it on release. */
const PLAY_DISTANCE = 90

export class HandView {
  readonly el: HTMLDivElement
  private order: number[] = []
  private cards = new Map<number, HTMLDivElement>()
  private cardWidth = 90
  /** How each card is turned in the hand: quarter turns (unbounded, so animations spin the short way) and mirroring. */
  private orient = new Map<number, { turns: number; flip: boolean }>()
  private drag: { id: number; pointerId: number; startX: number; startY: number; baseX: number } | null = null

  private opts: HandOptions

  constructor(opts: HandOptions = { interactive: true, minCard: 64, maxCard: 110 }) {
    this.opts = opts
    this.el = document.createElement('div')
    this.el.className = opts.interactive ? 'fan' : 'fan small'
    window.addEventListener('resize', () => this.layout())
    if (!opts.interactive) return
    this.el.addEventListener('pointerdown', (e) => this.onDown(e))
    // Moves and releases are heard on the window: a re-render moves this element,
    // which drops pointer capture, and the release must still end the drag.
    window.addEventListener('pointermove', (e) => this.onMove(e))
    window.addEventListener('pointerup', (e) => this.onUp(e))
    window.addEventListener('pointercancel', (e) => this.onUp(e))
    window.addEventListener('keydown', (e) => this.onKey(e))
  }

  /** Current order of card ids, left to right. */
  get cardOrder(): number[] {
    return [...this.order]
  }

  update(hand: number[]): void {
    const inHand = new Set(hand)
    const fresh = hand.filter((c) => !this.order.includes(c))
    this.order = this.order.filter((c) => inHand.has(c)).concat(fresh)

    for (const [id, card] of this.cards) {
      if (inHand.has(id)) continue
      this.cards.delete(id)
      this.orient.delete(id)
      card.classList.add('leaving')
      card.addEventListener('transitionend', () => card.remove(), { once: true })
      setTimeout(() => card.remove(), 600)
    }
    for (const id of fresh) {
      const card = document.createElement('div')
      card.className = 'hand-card entering'
      card.dataset.card = String(id)
      card.innerHTML = this.opts.faceDown ? '<div class="card-back"></div>' : cardSvg(id)
      this.el.append(card)
      this.cards.set(id, card)
    }
    this.layout()
    // Let the entering cards paint at their start position before sliding in.
    if (fresh.length) requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const id of fresh) this.cards.get(id)?.classList.remove('entering')
      this.layout()
    }))
  }

  private slots(n: number): Slot[] {
    // Keep a margin so the outer cards' tilt does not swing them off screen.
    const margin = this.opts.interactive ? 18 : 4
    const width = (this.el.clientWidth || 320) - margin * 2
    this.cardWidth = Math.max(this.opts.minCard, Math.min(this.opts.maxCard, width / 3.4))
    const spacing = n > 1 ? Math.min(this.cardWidth * 0.82, (width - this.cardWidth) / (n - 1)) : 0
    const spread = Math.min(7, 36 / Math.max(n, 1))
    const left = margin + (width - (spacing * (n - 1) + this.cardWidth)) / 2
    return Array.from({ length: n }, (_, i) => {
      const t = i - (n - 1) / 2
      return { x: left + i * spacing, y: Math.abs(t) * Math.abs(t) * 2.2, angle: t * spread }
    })
  }

  layout(): void {
    const slots = this.slots(this.order.length)
    this.el.style.height = `${this.cardWidth + (this.opts.interactive ? 40 : 14)}px`
    this.order.forEach((id, i) => {
      const card = this.cards.get(id)
      if (!card) return
      card.style.width = `${this.cardWidth}px`
      card.style.height = `${this.cardWidth}px`
      card.style.zIndex = String(i + 1)
      if (this.drag?.id === id) return
      const s = slots[i]
      card.style.transform = card.classList.contains('entering')
        ? `translate(${s.x}px, ${this.cardWidth * 1.6}px) rotate(${s.angle + 12}deg)`
        : `translate(${s.x}px, ${s.y + (this.opts.interactive ? 16 : 4)}px) rotate(${s.angle}deg) scale(var(--hover, 1))`
    })
  }

  private onDown(e: PointerEvent): void {
    const card = (e.target as Element).closest<HTMLDivElement>('.hand-card')
    if (!card || card.classList.contains('leaving') || e.button !== 0) return
    e.preventDefault()
    if (this.drag) this.onUp(e, true)
    const id = Number(card.dataset.card)
    const slot = this.slots(this.order.length)[this.order.indexOf(id)]
    this.drag = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: slot.x }
    card.setPointerCapture(e.pointerId)
    card.classList.add('dragging')
    card.style.zIndex = '100'
    this.onMove(e)
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.pointerId) return
    if (e.buttons === 0) return this.onUp(e)
    const card = this.cards.get(d.id)
    if (!card) return this.onUp(e)
    const x = d.baseX + (e.clientX - d.startX)
    const dy = e.clientY - d.startY
    const y = Math.max(-window.innerHeight, Math.min(30, dy < 0 ? dy : dy * 0.4))
    const playing = !!this.opts.onPlay && dy < -PLAY_DISTANCE
    card.classList.toggle('will-play', playing)
    card.style.transform = `translate(${x}px, ${y}px) rotate(0deg) scale(1.5)`

    // Move the card to the slot nearest its current position.
    const slots = this.slots(this.order.length)
    let best = 0
    slots.forEach((s, i) => {
      if (Math.abs(s.x - x) < Math.abs(slots[best].x - x)) best = i
    })
    const from = this.order.indexOf(d.id)
    if (best !== from) {
      this.order.splice(from, 1)
      this.order.splice(best, 0, d.id)
      this.layout()
      card.style.zIndex = '100'
    }
  }

  // While a card is held: R turns it clockwise, E counter-clockwise, F mirrors it.
  // Only the picture turns; matching ignores rotation and mirroring anyway.
  private onKey(e: KeyboardEvent): void {
    if (!this.drag || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key !== 'r' && key !== 'e' && key !== 'f') return
    e.preventDefault()
    const id = this.drag.id
    const o = this.orient.get(id) ?? { turns: 0, flip: false }
    // A mirrored card's picture turns the other way, so keep R clockwise on screen.
    const step = key === 'r' ? 1 : key === 'e' ? -1 : 0
    if (step) o.turns += o.flip ? -step : step
    else o.flip = !o.flip
    this.orient.set(id, o)
    const shape = this.cards.get(id)?.querySelector<SVGElement>('.card-shape')
    if (shape) shape.style.transform = `scaleX(${o.flip ? -1 : 1}) rotate(${o.turns * 90}deg)`
  }

  /** Briefly mark a card, e.g. to shake it after a wrong call. */
  flash(card: number, cls: string): void {
    const el = this.cards.get(card)
    if (!el) return
    el.classList.remove(cls)
    void el.offsetWidth // restart the animation
    el.classList.add(cls)
    setTimeout(() => el.classList.remove(cls), 700)
  }

  private onUp(e: PointerEvent, force = false): void {
    const d = this.drag
    if (!d || (!force && e.pointerId !== d.pointerId)) return
    const card = this.cards.get(d.id)
    const play = !!card?.classList.contains('will-play') && !force
    card?.classList.remove('dragging', 'will-play')
    this.drag = null
    this.layout()
    if (play) this.opts.onPlay?.(d.id)
  }
}
