import { canonical, legalTargets, sameStick, type Stick } from './geometry'
import { DECK_SIZE, SHAPES, SHAPE_CANON } from './shapes'

export type Variant = 'standard' | 'plus'
export const HAND_SIZE = 5

export interface Player {
  id: string
  name: string
  /** Card (shape) indices in hand. */
  hand: number[]
  /** Cards correctly played this round. */
  pile: number[]
  /** Cumulative score: +1 per correct play, −1 per wrong one (and per card left in Standard). */
  score: number
}

export interface GameState {
  variant: Variant
  roundsTotal: number
  round: number
  players: Player[]
  deck: number[]
  pattern: Stick[]
  current: number
  phase: 'playing' | 'roundOver' | 'gameOver'
  lastMove: { from: Stick; to: Stick } | null
  /** Counts moves; a claim names the move it saw so a stale claim is not penalised. */
  moveCount: number
  /** The most recent claim, for UI feedback. */
  lastClaim: { player: number; card: number; ok: boolean; seq: number } | null
  /** Cards correctly played since the last move, for UI highlighting. */
  lastPlayed: { player: number; card: number }[]
  log: string[]
  rng: number
}

export type Action =
  | { type: 'move'; playerId: string; index: number; to: Stick }
  | { type: 'claim'; playerId: string; card: number; seen: number }
  | { type: 'nextRound'; playerId: string }

export interface GameOptions {
  variant: Variant
  rounds: number
  seed?: number
}

// mulberry32: small seeded PRNG so a game is reproducible from its state.
function nextRandom(state: GameState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function shuffle<T>(state: GameState, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

export function newGame(players: { id: string; name: string }[], opts: GameOptions): GameState {
  if (players.length < 1 || players.length > 4) throw new Error('Matchstix needs 1–4 players')
  const state: GameState = {
    variant: opts.variant,
    roundsTotal: Math.max(1, opts.rounds),
    round: 0,
    players: players.map((p) => ({ ...p, hand: [], pile: [], score: 0 })),
    deck: [],
    pattern: [],
    current: 0,
    phase: 'playing',
    lastMove: null,
    moveCount: 0,
    lastClaim: null,
    lastPlayed: [],
    log: [],
    rng: opts.seed ?? Math.floor(Math.random() * 2 ** 31),
  }
  startRound(state)
  return state
}

function startRound(state: GameState): void {
  state.round += 1
  state.deck = shuffle(state, [...Array(DECK_SIZE).keys()])
  const patternCard = state.deck.pop()!
  state.pattern = SHAPES[patternCard].map((s) => ({ ...s }))
  for (const p of state.players) {
    p.hand = state.deck.splice(-HAND_SIZE, HAND_SIZE)
    p.pile = []
  }
  state.current = (state.round - 1) % state.players.length
  state.phase = 'playing'
  state.lastMove = null
  state.lastPlayed = []
  state.log.push(`Round ${state.round} begins. ${state.players[state.current].name} starts.`)
}

/** Index in `hand` of a card matching the pattern, or -1. */
export function matchingCard(hand: number[], pattern: Stick[]): number {
  const canon = canonical(pattern)
  return hand.findIndex((c) => SHAPE_CANON[c] === canon)
}

export function applyAction(prev: GameState, action: Action): GameState {
  const state: GameState = structuredClone(prev)
  if (action.type === 'nextRound') {
    if (state.phase !== 'roundOver') throw new Error('The round is not over yet')
    startRound(state)
    return state
  }
  if (state.phase !== 'playing') throw new Error('The round is over')
  if (action.type === 'claim') claim(state, action)
  else move(state, action)
  return state
}

// On your turn you move one stick; the turn then passes on. Nothing is matched
// automatically: players claim matches themselves.
function move(state: GameState, action: Extract<Action, { type: 'move' }>): void {
  const me = state.players[state.current]
  if (me.id !== action.playerId) throw new Error(`It is ${me.name}'s turn`)
  if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.pattern.length)
    throw new Error('No such stick')
  const to = action.to
  if (!legalTargets(state.pattern, action.index).some((t) => sameStick(t, to)))
    throw new Error('That stick cannot go there')

  const from = state.pattern[action.index]
  state.pattern[action.index] = { x: to.x, y: to.y, d: to.d }
  state.lastMove = { from, to: state.pattern[action.index] }
  state.lastPlayed = []
  state.moveCount += 1
  state.current = (state.current + 1) % state.players.length
}

// Any player may play a card at any time. A match scores +1; a wrong call costs 1
// and the card stays in hand. A claim made before the latest move is refused
// without penalty, since the player could not have seen the new pattern.
function claim(state: GameState, action: Extract<Action, { type: 'claim' }>): void {
  const i = state.players.findIndex((p) => p.id === action.playerId)
  const p = state.players[i]
  if (!p) throw new Error('Unknown player')
  const h = p.hand.indexOf(action.card)
  if (h < 0) throw new Error('That card is not in your hand')
  if (action.seen !== state.moveCount) throw new Error('Too late — the pattern just changed')

  const ok = SHAPE_CANON[action.card] === canonical(state.pattern)
  state.lastClaim = { player: i, card: action.card, ok, seq: (state.lastClaim?.seq ?? 0) + 1 }
  if (!ok) {
    p.score -= 1
    state.log.push(`${p.name} played a card that does not match (−1).`)
    return
  }
  p.hand.splice(h, 1)
  p.pile.push(action.card)
  p.score += 1
  state.lastPlayed.push({ player: i, card: action.card })
  state.log.push(`${p.name} matched a card (+1).`)

  if (state.variant === 'standard') {
    if (p.hand.length === 0) {
      for (const q of state.players) q.score -= q.hand.length
      state.log.push(`${p.name} emptied their hand!`)
      endRound(state)
    }
  } else if (state.deck.length) {
    p.hand.push(state.deck.pop()!)
  } else {
    state.log.push('The deck is empty.')
    endRound(state)
  }
}

function endRound(state: GameState): void {
  state.phase = state.round >= state.roundsTotal ? 'gameOver' : 'roundOver'
  if (state.phase === 'gameOver') state.log.push(`Game over! ${winnerNames(state).join(' & ')} wins.`)
}

/** Highest cumulative score. */
export function winnerNames(state: GameState): string[] {
  const best = Math.max(...state.players.map((p) => p.score))
  return state.players.filter((p) => p.score === best).map((p) => p.name)
}

/** A move for the current player that matches one of their cards, if any. */
export function findMatchingMove(state: GameState): { index: number; to: Stick } | null {
  const hand = new Set(state.players[state.current].hand.map((c) => SHAPE_CANON[c]))
  for (let index = 0; index < state.pattern.length; index++) {
    for (const to of legalTargets(state.pattern, index)) {
      const next = state.pattern.map((s, i) => (i === index ? to : s))
      if (hand.has(canonical(next))) return { index, to }
    }
  }
  return null
}

export function allMoves(state: GameState): { index: number; to: Stick }[] {
  return state.pattern.flatMap((_, index) => legalTargets(state.pattern, index).map((to) => ({ index, to })))
}
