import { canonical, endpoints, normalize, stickKey, sticksAt, type Stick } from './geometry'

/**
 * All free polysticks of `n` unit sticks (distinct up to rotation and mirroring),
 * grown breadth-first from a single stick. For n = 5 there are 55 of them,
 * matching the 55 cards in the Matchstix box.
 */
export function generateShapes(n: number): Stick[][] {
  let level = new Map<string, Stick[]>([[canonical([{ x: 0, y: 0, d: 'H' }]), [{ x: 0, y: 0, d: 'H' }]]])
  for (let size = 1; size < n; size++) {
    const next = new Map<string, Stick[]>()
    for (const shape of level.values()) {
      const taken = new Set(shape.map(stickKey))
      for (const s of shape) {
        for (const p of endpoints(s)) {
          for (const c of sticksAt(p)) {
            if (taken.has(stickKey(c))) continue
            const grown = [...shape, c]
            const key = canonical(grown)
            if (!next.has(key)) next.set(key, grown)
          }
        }
      }
    }
    level = next
  }
  return [...level.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, s]) => normalize(s))
}

/** One card per pentastick shape; a card is referred to by its index here. */
export const SHAPES: Stick[][] = generateShapes(5)
export const SHAPE_CANON: string[] = SHAPES.map(canonical)
export const DECK_SIZE = SHAPES.length
