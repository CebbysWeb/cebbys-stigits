import { endpoints, normalize, type Stick } from '../engine/geometry'
import { SHAPES } from '../engine/shapes'

// Lattice y grows upwards; SVG y grows downwards, so flip y when drawing.
const line = (s: Stick, attrs: string): string => {
  const [a, b] = endpoints(s)
  return `<line x1="${a.x}" y1="${-a.y}" x2="${b.x}" y2="${-b.y}" ${attrs}/>`
}

/** A matchstick: a wooden shaft with a red head on its second endpoint. */
export function matchstick(s: Stick, attrs = ''): string {
  const [, b] = endpoints(s)
  return `<g ${attrs}>${line(s, 'class="shaft"')}<circle class="head" cx="${b.x}" cy="${-b.y}" r="0.09"/></g>`
}

function viewBox(sticks: Stick[], pad: number): string {
  const pts = sticks.flatMap(endpoints)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => -p.y)
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  return `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`
}

export function cardSvg(card: number): string {
  const shape = normalize(SHAPES[card])
  return `<svg class="card-shape" viewBox="${viewBox(shape, 0.4)}">${shape.map((s) => matchstick(s)).join('')}</svg>`
}

export interface BoardView {
  pattern: Stick[]
  selected: number | null
  targets: Stick[]
  lastTo: Stick | null
  interactive: boolean
}

/** An endless dot grid: a pattern tile repeated over a plane far larger than any view. */
const GRID = `<defs><pattern id="grid-dots" width="1" height="1" x="-0.5" y="-0.5" patternUnits="userSpaceOnUse">
  <circle class="dot" cx="0.5" cy="0.5" r="0.04"/></pattern></defs>
  <rect x="-500" y="-500" width="1000" height="1000" fill="url(#grid-dots)"/>`

export function boardSvg(v: BoardView, vb: string): string {
  const dots = [GRID]

  const sticks = v.pattern.map((s, i) => {
    const cls = ['stick', i === v.selected ? 'selected' : '', v.interactive ? 'pickable' : '',
      v.lastTo && s.x === v.lastTo.x && s.y === v.lastTo.y && s.d === v.lastTo.d ? 'moved' : '']
    return matchstick(s, `class="${cls.join(' ')}" data-stick="${i}"`) +
      (v.interactive ? line(s, `class="hit" data-stick="${i}"`) : '')
  })
  const targets = v.targets.map((t, i) => line(t, `class="ghost" data-ghost="${i}"`))
  return `<svg class="board ${v.interactive ? 'interactive' : ''}" viewBox="${vb}">${dots.join('')}${targets.join('')}${sticks.join('')}<g class="drag-layer"></g></svg>`
}

/** Midpoint of a stick in lattice coordinates, for snapping a dragged stick. */
export function midpoint(s: Stick): { x: number; y: number } {
  return s.d === 'H' ? { x: s.x + 0.5, y: s.y } : { x: s.x, y: s.y + 0.5 }
}
