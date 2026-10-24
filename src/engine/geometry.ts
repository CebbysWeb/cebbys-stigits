// Sticks are unit segments on a square lattice. A stick is identified by its
// lower-left endpoint and direction: H spans (x,y)-(x+1,y), V spans (x,y)-(x,y+1).
export type Dir = 'H' | 'V'
export interface Stick {
  x: number
  y: number
  d: Dir
}
export interface Pt {
  x: number
  y: number
}

export const stickKey = (s: Stick): string => `${s.x},${s.y},${s.d}`
export const ptKey = (p: Pt): string => `${p.x},${p.y}`
export const sameStick = (a: Stick, b: Stick): boolean =>
  a.x === b.x && a.y === b.y && a.d === b.d

export function endpoints(s: Stick): [Pt, Pt] {
  return s.d === 'H'
    ? [{ x: s.x, y: s.y }, { x: s.x + 1, y: s.y }]
    : [{ x: s.x, y: s.y }, { x: s.x, y: s.y + 1 }]
}

export function stickFromPoints(a: Pt, b: Pt): Stick {
  if (a.y === b.y && Math.abs(a.x - b.x) === 1) return { x: Math.min(a.x, b.x), y: a.y, d: 'H' }
  if (a.x === b.x && Math.abs(a.y - b.y) === 1) return { x: a.x, y: Math.min(a.y, b.y), d: 'V' }
  throw new Error(`Points ${ptKey(a)} and ${ptKey(b)} are not a unit stick`)
}

/** The four sticks that have `p` as an endpoint. */
export function sticksAt(p: Pt): Stick[] {
  return [
    { x: p.x, y: p.y, d: 'H' },
    { x: p.x - 1, y: p.y, d: 'H' },
    { x: p.x, y: p.y, d: 'V' },
    { x: p.x, y: p.y - 1, d: 'V' },
  ]
}

// The 8 symmetries of the square: 4 rotations, each optionally mirrored.
const TRANSFORMS: ((p: Pt) => Pt)[] = [
  (p) => ({ x: p.x, y: p.y }),
  (p) => ({ x: -p.y, y: p.x }),
  (p) => ({ x: -p.x, y: -p.y }),
  (p) => ({ x: p.y, y: -p.x }),
  (p) => ({ x: -p.x, y: p.y }),
  (p) => ({ x: p.y, y: p.x }),
  (p) => ({ x: p.x, y: -p.y }),
  (p) => ({ x: -p.y, y: -p.x }),
]

/** Shift sticks so the smallest endpoint coordinates are 0, sorted for stable output. */
export function normalize(sticks: Stick[]): Stick[] {
  const pts = sticks.flatMap(endpoints)
  const minX = Math.min(...pts.map((p) => p.x))
  const minY = Math.min(...pts.map((p) => p.y))
  return sticks
    .map((s) => ({ x: s.x - minX, y: s.y - minY, d: s.d }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.d.localeCompare(b.d))
}

const shapeString = (sticks: Stick[]): string => normalize(sticks).map(stickKey).join(';')

/**
 * Canonical form of a shape, invariant under translation, rotation and mirroring.
 * Two patterns match exactly when their canonical forms are equal.
 */
export function canonical(sticks: Stick[]): string {
  let best: string | null = null
  for (const t of TRANSFORMS) {
    const moved = sticks.map((s) => {
      const [a, b] = endpoints(s)
      return stickFromPoints(t(a), t(b))
    })
    const str = shapeString(moved)
    if (best === null || str < best) best = str
  }
  return best ?? ''
}

/** True when all sticks form one piece through shared endpoints. */
export function isConnected(sticks: Stick[]): boolean {
  if (sticks.length <= 1) return true
  const seen = new Set<number>([0])
  const queue = [0]
  while (queue.length) {
    const i = queue.pop()!
    const mine = endpoints(sticks[i]).map(ptKey)
    sticks.forEach((s, j) => {
      if (seen.has(j)) return
      if (endpoints(s).some((p) => mine.includes(ptKey(p)))) {
        seen.add(j)
        queue.push(j)
      }
    })
  }
  return seen.size === sticks.length
}

/**
 * Where stick `index` of `pattern` may be moved: a new, unoccupied position
 * that touches the remaining sticks and leaves the whole pattern connected.
 */
export function legalTargets(pattern: Stick[], index: number): Stick[] {
  const rest = pattern.filter((_, i) => i !== index)
  const taken = new Set(pattern.map(stickKey))
  const seen = new Set<string>()
  const out: Stick[] = []
  for (const s of rest) {
    for (const p of endpoints(s)) {
      for (const c of sticksAt(p)) {
        const k = stickKey(c)
        if (taken.has(k) || seen.has(k)) continue
        seen.add(k)
        if (isConnected([...rest, c])) out.push(c)
      }
    }
  }
  return out
}
