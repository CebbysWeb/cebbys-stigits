import { canonical, legalTargets, sameStick, type Stick } from './geometry'
import { DECK_SIZE, SHAPES, SHAPE_CANON } from './shapes'

export const HAND_SIZE = 5
export const MAX_PLAYERS = 12

/** Cards each player holds by default: fewer in big games so the 55-card deck still lasts. */
export const autoHandSize = (players: number): number => (players <= 6 ? HAND_SIZE : players <= 9 ? 4 : 3)

/** Table rules the host picks in the lobby. */
export type GameMode = 'emptyDeck' | 'rounds'

export interface Settings {
  /** Empty deck: one deal of a fixed pile; most played cards wins when nothing is left to draw.
   *  Rounds: the deck never runs out; a round is one turn each; highest score after N rounds wins. */
  mode: GameMode
  /** Rounds mode: how many rounds (one turn per player each). */
  rounds: number
  /** Cards per player; 0 picks a size from the player count. */
  handSize: number
  /** Empty deck: cards in the draw pile beyond the dealt hands; -1 uses the whole deck. */
  extraCards: number
  /** Whether players may turn (R/E) and mirror (F) a held card to compare it. */
  rotate: boolean
  mirror: boolean
  /** A wrong call costs this many points (rounds) or played cards (empty deck). */
  penalty: number
  /** Show the green spots a picked-up stick can go to. */
  hints: boolean
  botSpeed: 'relaxed' | 'normal' | 'quick'
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'emptyDeck', rounds: 3, handSize: 0, extraCards: -1, rotate: true, mirror: true, penalty: 1, hints: true, botSpeed: 'normal',
}

export const handSizeFor = (s: Settings, players: number): number => s.handSize || autoHandSize(players)

/** Cards in the draw pile at the start of a round (after the pattern card and the deal). */
export function deckFor(s: Settings, players: number): number {
  const rest = DECK_SIZE - 1 - players * handSizeFor(s, players)
  return s.extraCards < 0 || s.mode === 'rounds' ? rest : Math.min(rest, s.extraCards)
}

export interface Player {
  id: string
  name: string
  /** Card (shape) indices in hand. */
  hand: number[]
  /** Cards correctly played this round. */
  pile: number[]
  /** Cumulative score: +1 per correct play, −1 per wrong one. */
  score: number
}

const handSize = (state: GameState): number => handSizeFor(state.settings, state.players.length)

export interface GameState {
  /** Turn number within the round, starting at 1; goes up only when a player ends their turn. */
  turn: number
  settings: Settings
  roundsTotal: number
  round: number
  players: Player[]
  deck: number[]
  pattern: Stick[]
  current: number
  /** Moves the current player may still make: one per turn, plus one after each of their own matches. */
  movesLeft: number
  /** Whether the current player has moved this turn. Moving is optional: a lucky player
   *  can play a card that already matches without moving at all. */
  turnMoved: boolean
  phase: 'playing' | 'roundOver' | 'gameOver'
  lastMove: { from: Stick; to: Stick } | null
  /** Counts moves; a claim names the move it saw so a stale claim is not penalised. */
  moveCount: number
  /** The most recent claim, for UI feedback. */
  lastClaim: { player: number; card: number; ok: boolean; seq: number } | null
  /** Cards correctly played since the last move, for UI highlighting. */
  lastPlayed: { player: number; card: number }[]
  /** Every card correctly played this round, oldest first: the shared played pile. */
  played: { player: number; card: number }[]
  log: string[]
  rng: number
}

export type Action =
  | { type: 'move'; playerId: string; index: number; to: Stick }
  | { type: 'claim'; playerId: string; card: number; seen: number }
  | { type: 'endTurn'; playerId: string }
  | { type: 'nextRound'; playerId: string }

export interface GameOptions extends Partial<Settings> {
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
  if (players.length < 1 || players.length > MAX_PLAYERS) throw new Error(`Matchstix needs 1–${MAX_PLAYERS} players`)
  const state: GameState = {
    settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'seed')) },
    roundsTotal: opts.mode === 'rounds' ? Math.max(1, opts.rounds) : 1,
    round: 0,
    players: players.map((p) => ({ ...p, hand: [], pile: [], score: 0 })),
    deck: [],
    pattern: [],
    current: 0,
    movesLeft: 1,
    turnMoved: false,
    turn: 1,
    phase: 'playing',
    lastMove: null,
    moveCount: 0,
    lastClaim: null,
    lastPlayed: [],
    played: [],
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
    p.hand = state.deck.splice(-handSize(state), handSize(state))
    p.pile = []
  }
  // Cards beyond the chosen deck size sit out this round.
  state.deck.splice(0, Math.max(0, state.deck.length - deckFor(state.settings, state.players.length)))
  state.current = (state.round - 1) % state.players.length
  state.movesLeft = 1
  state.turnMoved = false
  state.turn = 1
  state.phase = 'playing'
  state.lastMove = null
  state.lastPlayed = []
  state.played = []
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
  else if (action.type === 'endTurn') endTurn(state, action)
  else move(state, action)
  return state
}

// On your turn you move a stick. Playing a matching card earns another move, so a
// good turn can chain several. Nothing is matched automatically.
function move(state: GameState, action: Extract<Action, { type: 'move' }>): void {
  const me = state.players[state.current]
  if (me.id !== action.playerId) throw new Error(`It is ${me.name}'s turn`)
  if (state.movesLeft < 1) throw new Error('Play a matching card to move again, or end your turn')
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
  state.movesLeft -= 1
  state.turnMoved = true
}

// Ending a turn refills every hand below five cards, mover first, then passes the
// turn on. If the deck cannot refill everyone, the round is over.
function endTurn(state: GameState, action: Extract<Action, { type: 'endTurn' }>): void {
  const me = state.players[state.current]
  if (me.id !== action.playerId) throw new Error(`It is ${me.name}'s turn`)
  const n = state.players.length
  for (let k = 0; k < n; k++) {
    const p = state.players[(state.current + k) % n]
    while (p.hand.length < handSize(state)) {
      // In rounds mode the deck never runs out: reshuffle every card nobody holds.
      if (!state.deck.length && state.settings.mode === 'rounds') {
        const held = new Set(state.players.flatMap((x) => x.hand))
        state.deck = shuffle(state, [...Array(DECK_SIZE).keys()].filter((c) => !held.has(c)))
      }
      if (!state.deck.length) break
      p.hand.push(state.deck.pop()!)
    }
  }
  if (state.players.some((p) => p.hand.length < handSize(state))) {
    state.log.push('The deck ran out.')
    endRound(state)
    return
  }
  state.current = (state.current + 1) % n
  state.turn += 1
  // Rounds mode: a round is one turn for every player; the board carries on.
  if (state.settings.mode === 'rounds' && state.turn > n) {
    if (state.round >= state.roundsTotal) {
      state.phase = 'gameOver'
      state.log.push(`Game over! ${winnerNames(state).join(' & ')} wins.`)
      return
    }
    state.round += 1
    state.turn = 1
    state.log.push(`Round ${state.round} begins.`)
  }
  state.movesLeft = 1
  state.turnMoved = false
  state.lastPlayed = []
  state.log.push(`${state.players[state.current].name}'s turn.`)
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
    const cost = state.settings.penalty
    if (state.settings.mode === 'emptyDeck') {
      // Played cards are what count here, so a wrong call gives some back (out of the game).
      for (const card of p.pile.splice(Math.max(0, p.pile.length - cost))) {
        const at = state.played.findLastIndex((x) => x.card === card)
        if (at >= 0) state.played.splice(at, 1)
      }
      p.score = p.pile.length
      state.log.push(`${p.name} played a card that does not match${cost ? ` (−${cost} played)` : ''}.`)
    } else {
      p.score -= cost
      state.log.push(`${p.name} played a card that does not match${cost ? ` (−${cost})` : ''}.`)
    }
    return
  }
  p.hand.splice(h, 1)
  p.pile.push(action.card)
  p.score += 1
  state.lastPlayed.push({ player: i, card: action.card })
  state.played.push({ player: i, card: action.card })
  state.log.push(`${p.name} matched a card (+1).`)

  // The player whose turn it is earns another move with each match.
  if (i === state.current) state.movesLeft = 1
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
