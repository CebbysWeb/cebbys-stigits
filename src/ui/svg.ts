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

export function boardSvg(v: BoardView): string {
  // Frame the pattern plus a margin wide enough for any legal target.
  const vb = viewBox(v.pattern, 1.6)
  const [x0, y0, w, h] = vb.split(' ').map(Number)
  const dots: string[] = []
  for (let x = Math.ceil(x0); x <= x0 + w; x++)
    for (let y = Math.ceil(y0); y <= y0 + h; y++) dots.push(`<circle class="dot" cx="${x}" cy="${y}" r="0.04"/>`)

  const sticks = v.pattern.map((s, i) => {
    const cls = ['stick', i === v.selected ? 'selected' : '', v.interactive ? 'pickable' : '',
      v.lastTo && s.x === v.lastTo.x && s.y === v.lastTo.y && s.d === v.lastTo.d ? 'moved' : '']
    return matchstick(s, `class="${cls.join(' ')}" data-stick="${i}"`) +
      (v.interactive ? line(s, `class="hit" data-stick="${i}"`) : '')
  })
  const targets = v.targets.map((t, i) => line(t, 'class="ghost"') + line(t, `class="hit" data-target="${i}"`))
  return `<svg class="board" viewBox="${vb}">${dots.join('')}${sticks.join('')}${targets.join('')}</svg>`
}
