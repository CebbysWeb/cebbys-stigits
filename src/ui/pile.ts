import { t } from '../i18n'
import { cardSvg } from './svg'

/** How many cards of the pile are drawn; older ones are hidden underneath. */
const VISIBLE = 6
const FLIGHT_MS = 650

/** A stable, slightly messy tilt and offset for each card, so the pile looks tossed. */
function scatter(card: number): { angle: number; dx: number; dy: number } {
  const h = Math.imul(card + 1, 2654435761) >>> 0
  return { angle: (h % 25) - 12, dx: ((h >>> 8) % 9) - 4, dy: ((h >>> 16) % 7) - 3 }
}

/**
 * The shared pile of played cards beside my hand. Played cards fly here from
 * whichever hand played them. The element persists across renders.
 */
export class PlayedPile {
  readonly el: HTMLDivElement
  private cards: number[] = []
  /** Cards still in flight; they join the pile when they land. */
  private flying = new Set<number>()

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'pile'
  }

  update(cards: number[]): void {
    this.cards = cards
    this.draw()
  }

  private draw(): void {
    const shown = this.cards.filter((c) => !this.flying.has(c)).slice(-VISIBLE)
    const count = this.cards.length - this.flying.size
    this.el.innerHTML = `${shown.map((c) => {
      const s = scatter(c)
      return `<div class="pile-card" data-card="${c}" style="transform: translate(${s.dx}px, ${s.dy}px) rotate(${s.angle}deg)">${cardSvg(c)}</div>`
    }).join('')}${count ? '' : `<div class="pile-empty"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 8v7M9 12l3 3 3-3"/></svg>${t.dropHere}</div>`}<span class="pile-count">${count ? t.nPlayed(count) : t.playedCards}</span>`
  }

  /**
   * Animate `card` flying from `from` (the card's spot in a hand, captured before
   * the hand redrew) onto the pile.
   */
  fly(card: number, from: DOMRect, fromOpacity: number): void {
    this.flying.add(card)
    this.draw()
    const to = this.el.getBoundingClientRect()
    const size = to.width
    const s = scatter(card)
    const ghost = document.createElement('div')
    ghost.className = 'pile-card flying'
    ghost.innerHTML = cardSvg(card)
    Object.assign(ghost.style, { width: `${size}px`, height: `${size}px`, left: '0px', top: '0px' })
    document.body.append(ghost)

    const startScale = Math.max(from.width, from.height) / size
    const at = (x: number, y: number, scale: number, angle: number) =>
      `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${angle}deg) scale(${scale})`
    const fromX = from.left + from.width / 2
    const fromY = from.top + from.height / 2
    const toX = to.left + to.width / 2 + s.dx
    const toY = to.top + to.height / 2 + s.dy
    // Arc upwards on the way, like a tossed card.
    const midX = (fromX + toX) / 2
    const midY = Math.min(fromY, toY) - 80
    const flight = ghost.animate([
      { transform: at(fromX, fromY, startScale, 0), opacity: fromOpacity },
      { transform: at(midX, midY, (startScale + 1) / 2 * 1.1, s.angle / 2 - 20), opacity: 1, offset: 0.5 },
      { transform: at(toX, toY, 1, s.angle), opacity: 1 },
    ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.3,.7,.4,1)' })
    const land = () => {
      ghost.remove()
      this.flying.delete(card)
      this.draw()
    }
    flight.onfinish = land
    flight.oncancel = land
  }
}
