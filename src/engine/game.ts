import { canonical, legalTargets, sameStick, type Stick } from './geometry'
import { DECK_SIZE, SHAPES, SHAPE_CANON } from './shapes'

export type Variant = 'standard' | 'plus'
export const HAND_SIZE = 5

export interface Player {
  id: string
  name: string
  /** Card (shape) indices in hand. */
  hand: number[]
  /** Cards played this round (Plus variant scoring). */
  pile: number[]
  /** Cumulative score: minus points in Standard, plus points in Plus. */
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
  /** Cards matched by the last move, for UI highlighting. */
  lastPlayed: { player: number; card: number }[]
  log: string[]
  rng: number
}

export type Action =
  | { type: 'move'; playerId: string; index: number; to: Stick }
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

  if (state.variant === 'standard') resolveStandard(state)
  else resolvePlus(state)
  return state
}

function playCard(state: GameState, playerIndex: number, handIndex: number, toPile: boolean): void {
  const p = state.players[playerIndex]
  const [card] = p.hand.splice(handIndex, 1)
  if (toPile) p.pile.push(card)
  state.lastPlayed.push({ player: playerIndex, card })
  state.log.push(`${p.name} matched a card.`)
}

// Standard: the mover and anyone else holding a match lay down one card each.
// The mover draws if they could not match. First to an empty hand ends the round.
function resolveStandard(state: GameState): void {
  const n = state.players.length
  let moverMatched = false
  for (let k = 0; k < n; k++) {
    const i = (state.current + k) % n
    const h = matchingCard(state.players[i].hand, state.pattern)
    if (h >= 0) {
      playCard(state, i, h, false)
      if (k === 0) moverMatched = true
    }
  }
  const mover = state.players[state.current]
  if (!moverMatched && state.deck.length) {
    mover.hand.push(state.deck.pop()!)
    state.log.push(`${mover.name} drew a card.`)
  }

  if (state.players.some((p) => p.hand.length === 0)) {
    const winners = state.players.filter((p) => p.hand.length === 0).map((p) => p.name)
    for (const p of state.players) p.score -= p.hand.length
    state.log.push(`${winners.join(' & ')} emptied their hand!`)
    endRound(state)
  } else {
    state.current = (state.current + 1) % n
  }
}

// Plus: each match by the mover gives another move. The turn ends on a move
// without a match (or an empty hand); the mover refills to five. A player who
// cannot refill ends the round and everyone scores their played pile.
function resolvePlus(state: GameState): void {
  const mover = state.players[state.current]
  const h = matchingCard(mover.hand, state.pattern)
  if (h >= 0) {
    playCard(state, state.current, h, true)
    if (mover.hand.length > 0) return // extra move
  }
  while (mover.hand.length < HAND_SIZE && state.deck.length) mover.hand.push(state.deck.pop()!)
  if (mover.hand.length < HAND_SIZE) {
    state.log.push(`${mover.name} cannot refill to ${HAND_SIZE} cards.`)
    for (const p of state.players) p.score += p.pile.length
    endRound(state)
  } else {
    state.current = (state.current + 1) % state.players.length
  }
}

function endRound(state: GameState): void {
  state.phase = state.round >= state.roundsTotal ? 'gameOver' : 'roundOver'
  if (state.phase === 'gameOver') state.log.push(`Game over! ${winnerNames(state).join(' & ')} wins.`)
}

/** Best cumulative score: fewest minus points (Standard) or most points (Plus). */
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
