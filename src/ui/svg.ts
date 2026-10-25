import { endpoints, normalize, type Stick } from '../engine/geometry'
import { SHAPES } from '../engine/shapes'

// Lattice y grows upwards; SVG y grows downwards, so flip y when drawing.
const line = (s: Stick, attrs: string): string => {
  const [a, b] = endpoints(s)
  return `<line x1="${a.x}" y1="${-a.y}" x2="${b.x}" y2="${-b.y}" ${attrs}/>`
}

/** Gap left at each end of a stick, so sticks meeting at a point do not overlap. */
const INSET = 0.13

/** A plain stick, drawn a little short of its endpoints. */
export function stickSvg(s: Stick, attrs = ''): string {
  const [a, b] = endpoints(s)
  const dx = (b.x - a.x) * INSET
  const dy = (b.y - a.y) * INSET
  return `<g ${attrs}><line class="shaft" x1="${a.x + dx}" y1="${-(a.y + dy)}" x2="${b.x - dx}" y2="${-(b.y - dy)}"/></g>`
}

/** Each card's own stick colour: hues spread by the golden angle so neighbours differ. */
export const cardColor = (card: number): string => `hsl(${Math.round((card * 137.508) % 360)} 70% var(--card-l, 42%))`

/** Every card uses the same scale: a fixed 6×6 window of lattice, big enough for any pentastick. */
const CARD_SPAN = 6

export function cardSvg(card: number): string {
  const shape = normalize(SHAPES[card])
  const pts = shape.flatMap(endpoints)
  // The centre of the sticks' bounding box is the centre of the card.
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => -p.y)
  const x0 = (Math.min(...xs) + Math.max(...xs) - CARD_SPAN) / 2
  const y0 = (Math.min(...ys) + Math.max(...ys) - CARD_SPAN) / 2
  // Grid lines stay on the lattice, so they may sit half a unit off the card's edges.
  let grid = ''
  for (let x = Math.ceil(x0); x <= x0 + CARD_SPAN; x++) grid += `M${x} ${y0}V${y0 + CARD_SPAN}`
  for (let y = Math.ceil(y0); y <= y0 + CARD_SPAN; y++) grid += `M${x0} ${y}H${x0 + CARD_SPAN}`
  return `<svg class="card-shape" viewBox="${x0} ${y0} ${CARD_SPAN} ${CARD_SPAN}" style="--stick: ${cardColor(card)}"><path class="card-grid" d="${grid}"/>${shape.map((s) => stickSvg(s)).join('')}</svg>`
}

export interface BoardView {
  pattern: Stick[]
  selected: number | null
  targets: Stick[]
  lastTo: Stick | null
  interactive: boolean
  /** Draw the spots a picked-up stick can go to. */
  hints?: boolean
  /** Which sticks may be picked up; all of them when omitted. */
  movable?: (index: number) => boolean
}

/**
 * Endless squared exercise-book paper: one tile per lattice unit, repeated over a
 * plane far larger than any view. Main lines sit on the lattice where sticks lie;
 * fainter lines split each square in four. The tile is offset by half a unit so
 * each line is drawn whole rather than split across tile edges.
 */
const GRID = `<defs><pattern id="grid-paper" width="1" height="1" x="-0.5" y="-0.5" patternUnits="userSpaceOnUse">
  <path class="grid-minor" d="M0 0V1M1 0V1M0 0H1M0 1H1"/>
  <path class="grid-major" d="M0.5 0V1M0 0.5H1"/></pattern></defs>
  <rect x="-500" y="-500" width="1000" height="1000" fill="url(#grid-paper)"/>`

export function boardSvg(v: BoardView, vb: string): string {
  const grid = GRID

  const sticks = v.pattern.map((s, i) => {
    const pickable = v.interactive && (v.movable?.(i) ?? true)
    const cls = ['stick', i === v.selected ? 'selected' : '', pickable ? 'pickable' : '',
      v.lastTo && s.x === v.lastTo.x && s.y === v.lastTo.y && s.d === v.lastTo.d ? 'moved' : '']
    return stickSvg(s, `class="${cls.join(' ')}" data-stick="${i}"`) +
      (pickable ? line(s, `class="hit" data-stick="${i}"`) : '')
  })
  const targets = v.targets.map((t, i) => line(t, `class="ghost ${v.hints === false ? 'blind' : ''}" data-ghost="${i}"`))
  return `<svg class="board ${v.interactive ? 'interactive' : ''}" viewBox="${vb}">${grid}${targets.join('')}${sticks.join('')}<g class="drag-layer"></g></svg>`
}

/** Midpoint of a stick in lattice coordinates, for snapping a dragged stick. */
export function midpoint(s: Stick): { x: number; y: number } {
  return s.d === 'H' ? { x: s.x + 0.5, y: s.y } : { x: s.x, y: s.y + 0.5 }
}
