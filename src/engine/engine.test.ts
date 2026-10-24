import { describe, expect, it } from 'vitest'
import { canonical, isConnected, legalTargets, normalize, type Stick } from './geometry'
import { DECK_SIZE, SHAPES, SHAPE_CANON, generateShapes } from './shapes'
import { allMoves, applyAction, findMatchingMove, newGame, type GameState } from './game'

const H = (x: number, y: number): Stick => ({ x, y, d: 'H' })
const V = (x: number, y: number): Stick => ({ x, y, d: 'V' })

describe('geometry', () => {
  // An "L": three sticks along the bottom, two up the left side.
  const L = [H(0, 0), H(1, 0), H(2, 0), V(0, 0), V(0, 1)]

  it('ignores translation', () => {
    expect(canonical(L.map((s) => ({ ...s, x: s.x + 7, y: s.y - 3 })))).toBe(canonical(L))
  })

  it('ignores rotation', () => {
    // L rotated 90°: three sticks up the right side, two along the bottom.
    const rotated = [V(2, 0), V(2, 1), V(2, 2), H(0, 0), H(1, 0)]
    expect(canonical(rotated)).toBe(canonical(L))
  })

  it('ignores mirroring', () => {
    const mirrored = [H(0, 0), H(1, 0), H(2, 0), V(3, 0), V(3, 1)]
    expect(canonical(mirrored)).toBe(canonical(L))
  })

  it('tells different shapes apart', () => {
    const line = [H(0, 0), H(1, 0), H(2, 0), H(3, 0), H(4, 0)]
    expect(canonical(line)).not.toBe(canonical(L))
  })

  it('detects connectivity', () => {
    expect(isConnected(L)).toBe(true)
    expect(isConnected([H(0, 0), H(2, 0)])).toBe(false)
    expect(isConnected([H(0, 0), V(1, 0)])).toBe(true)
  })

  it('normalizes to the origin', () => {
    expect(normalize([H(5, 5), V(5, 5)])).toEqual([H(0, 0), V(0, 0)])
  })
})

describe('legal moves', () => {
  const line = [H(0, 0), H(1, 0), H(2, 0), H(3, 0), H(4, 0)]

  it('never targets an occupied spot or the stick itself', () => {
    for (const t of legalTargets(line, 4)) {
      expect(line.some((s) => s.x === t.x && s.y === t.y && s.d === t.d)).toBe(false)
    }
  })

  it('must touch the rest of the pattern', () => {
    const targets = legalTargets(line, 4)
    expect(targets).toContainEqual(H(-1, 0))
    expect(targets).toContainEqual(V(2, 0))
    expect(targets).not.toContainEqual(H(6, 0))
  })

  it('keeps the pattern in one piece when a middle stick moves', () => {
    // Removing the middle stick splits the line, so no spot can rejoin both halves.
    expect(legalTargets(line, 2)).toEqual([])
  })

  it('every resulting pattern is a valid pentastick', () => {
    const canon = new Set(SHAPE_CANON)
    for (const shape of SHAPES) {
      shape.forEach((_, i) => {
        for (const t of legalTargets(shape, i)) {
          expect(canon.has(canonical(shape.map((s, j) => (j === i ? t : s))))).toBe(true)
        }
      })
    }
  })
})

describe('big games', () => {
  it('deals smaller hands so up to 12 players fit the deck', () => {
    for (const [n, size] of [[6, 5], [7, 4], [9, 4], [10, 3], [12, 3]]) {
      const s = newGame(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rounds: 1, seed: 3 })
      expect(s.players.every((p) => p.hand.length === size)).toBe(true)
      expect(s.deck.length).toBe(DECK_SIZE - 1 - n * size)
    }
    expect(() => newGame(Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rounds: 1 })).toThrow()
  })
})

describe('deck', () => {
  it('has the 55 distinct pentasticks', () => {
    expect(DECK_SIZE).toBe(55)
    expect(new Set(SHAPE_CANON).size).toBe(55)
    expect(SHAPES.every((s) => s.length === 5 && isConnected(s))).toBe(true)
  })

  it('matches the known polystick counts', () => {
    expect([1, 2, 3, 4].map((n) => generateShapes(n).length)).toEqual([1, 2, 5, 16])
  })
})

const players = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Bob' },
]

/** The card in `player`'s hand matching the current pattern, if any. */
function matchFor(state: GameState, player: number): number | undefined {
  const canon = canonical(state.pattern)
  return state.players[player].hand.find((c) => SHAPE_CANON[c] === canon)
}

/** Move the current player so the pattern becomes `card`'s shape (or any move). */
function moveTo(state: GameState, card?: number): GameState {
  const moves = allMoves(state)
  const move = moves.find((m) => card !== undefined &&
    canonical(state.pattern.map((s, i) => (i === m.index ? m.to : s))) === SHAPE_CANON[card]) ?? moves[0]
  return applyAction(state, { type: 'move', playerId: state.players[state.current].id, ...move })
}

const claim = (state: GameState, playerId: string, card: number) =>
  applyAction(state, { type: 'claim', playerId, card, seen: state.moveCount })

/** Plays out a game: anyone holding a match claims it, otherwise the mover moves. */
function play(state: GameState, maxTurns = 20000): GameState {
  for (let i = 0; i < maxTurns && state.phase !== 'gameOver'; i++) {
    if (state.phase === 'roundOver') {
      state = applyAction(state, { type: 'nextRound', playerId: 'a' })
      continue
    }
    const claimer = state.players.findIndex((_, p) => matchFor(state, p) !== undefined)
    if (claimer >= 0) {
      state = claim(state, state.players[claimer].id, matchFor(state, claimer)!)
      continue
    }
    const mover = state.players[state.current].id
    if (state.movesLeft < 1) {
      state = applyAction(state, { type: 'endTurn', playerId: mover })
      continue
    }
    // Greedy bot: create a match for yourself if possible, else a varied move so it does not oscillate.
    const moves = allMoves(state)
    const move = findMatchingMove(state) ?? moves[(i * 7919) % moves.length]
    state = applyAction(state, { type: 'move', playerId: state.players[state.current].id, ...move })
  }
  return state
}

describe('turns and moves', () => {
  it('deals five cards each and sets the pattern', () => {
    const s = newGame(players, { rounds: 1, seed: 1 })
    expect(s.players.map((p) => p.hand.length)).toEqual([5, 5])
    expect(s.deck.length).toBe(55 - 1 - 10)
    expect(s.pattern.length).toBe(5)
  })

  it('rejects moves out of turn and illegal moves', () => {
    const s = newGame(players, { rounds: 1, seed: 1 })
    const move = allMoves(s)[0]
    expect(() => applyAction(s, { type: 'move', playerId: 'b', ...move })).toThrow(/turn/)
    expect(() => applyAction(s, { type: 'move', playerId: 'a', index: 0, to: H(99, 99) })).toThrow()
  })

  it('never plays cards by itself', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    const next = moveTo(s, s.players[0].hand[0])
    expect(next.players[0].hand).toEqual(s.players[0].hand)
    expect(next.moveCount).toBe(1)
  })
})

const end = (state: GameState) => applyAction(state, { type: 'endTurn', playerId: state.players[state.current].id })

describe('turns', () => {
  it('allows one move, then only ending the turn', () => {
    const s = moveTo(newGame(players, { rounds: 1, seed: 5 }))
    expect(s.current).toBe(0)
    expect(s.movesLeft).toBe(0)
    expect(() => moveTo(s)).toThrow(/end your turn/)
    const next = end(s)
    expect(next.current).toBe(1)
    expect(next.movesLeft).toBe(1)
  })

  it('a lucky player can play a card without moving and still has their move', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[1].hand = s.players[1].hand.filter((c) => c !== card)
    s.players[0].hand[0] = card
    const next = claim(s, 'a', card)
    expect(next.players[0].score).toBe(1)
    expect(next.movesLeft).toBe(1)
    expect(next.turnMoved).toBe(false)
  })

  it('moving is optional: the turn can end without a move', () => {
    const next = end(newGame(players, { rounds: 1, seed: 5 }))
    expect(next.current).toBe(1)
  })

  it('a match by the mover earns another move; a match by others does not', () => {
    let s = moveTo(newGame(players, { rounds: 1, seed: 5 }))
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[1].hand = s.players[1].hand.filter((c) => c !== card)
    s.players[0].hand[0] = card
    s = claim(s, 'a', card)
    expect(s.movesLeft).toBe(1)
    s = moveTo(s) // the chained move
    const other = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[0].hand = s.players[0].hand.filter((c) => c !== other)
    s.players[1].hand[0] = other
    s = claim(s, 'b', other)
    expect(s.players[1].score).toBe(1)
    expect(s.movesLeft).toBe(0)
  })

  it('a chain can empty the hand; everyone below five refills when the turn ends', () => {
    let s = moveTo(newGame(players, { rounds: 1, seed: 5 }))
    // Ann plays her last card; Bob holds seven and draws nothing.
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.deck = s.deck.filter((c) => c !== card)
    s.players[0].hand = [card]
    s.players[1].hand = s.deck.splice(0, 7)
    s = claim(s, 'a', card)
    expect(s.players[0].hand).toEqual([])
    const deck = s.deck.length
    s = end(s)
    expect(s.players[0].hand.length).toBe(5)
    expect(s.players[1].hand.length).toBe(7)
    expect(s.deck.length).toBe(deck - 5)
    expect(s.phase).toBe('playing')
  })

  it('ends the round when the deck cannot refill everyone', () => {
    let s = moveTo(newGame(players, { rounds: 1, seed: 5 }))
    s.deck = s.deck.slice(0, 2)
    s.players[0].hand = s.players[0].hand.slice(0, 2)
    s = end(s)
    expect(s.phase).toBe('gameOver')
    expect(s.players[0].hand.length).toBe(4)
  })
})

describe('claiming cards', () => {
  it('scores +1 for a correct claim, by any player, at any time', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    // It is Ann's turn, but Bob holds the shape on the grid and calls it.
    const bobsCard = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[0].hand = s.players[0].hand.filter((c) => c !== bobsCard)
    s.players[1].hand[0] = bobsCard
    expect(s.current).toBe(0)
    const next = claim(s, 'b', bobsCard)
    expect(next.players[1].score).toBe(1)
    expect(next.players[1].hand).not.toContain(bobsCard)
    expect(next.players[1].pile).toEqual([bobsCard])
    expect(next.played).toEqual([{ player: 1, card: bobsCard }])
    expect(next.lastClaim).toMatchObject({ player: 1, card: bobsCard, ok: true })
  })

  it('costs a point for a wrong claim and keeps the card', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    const canon = canonical(s.pattern)
    const wrong = s.players[0].hand.find((c) => SHAPE_CANON[c] !== canon)!
    const next = claim(s, 'a', wrong)
    expect(next.players[0].score).toBe(-1)
    expect(next.players[0].hand).toContain(wrong)
    expect(next.lastClaim).toMatchObject({ ok: false })
  })

  it('refuses a stale claim without penalty', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    const moved = moveTo(s)
    const card = moved.players[0].hand[0]
    expect(() => applyAction(moved, { type: 'claim', playerId: 'a', card, seen: s.moveCount })).toThrow(/Too late/)
  })

  it('rejects cards that are not in your hand', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    expect(() => claim(s, 'a', s.players[1].hand[0])).toThrow(/not in your hand/)
  })

  it('a claimed shape cannot be claimed again', () => {
    const s = newGame(players, { rounds: 1, seed: 5 })
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[0].hand[0] = card
    const next = claim(s, 'a', card)
    expect(() => claim(next, 'a', card)).toThrow(/not in your hand/)
  })
})

describe('full games', () => {
  it('plays a multi-round game to a scored finish', () => {
    const end = play(newGame(players, { rounds: 3, seed: 42 }))
    expect(end.phase).toBe('gameOver')
    expect(end.round).toBe(3)
    // The bot never calls wrong, so scores only grow, and the deck was used up.
    expect(end.players.every((p) => p.score > 0)).toBe(true)
    expect(end.deck.length).toBeLessThan(2 * 5)
  })

  it('plays a full four-player game', () => {
    const four = [...players, { id: 'c', name: 'Cid' }, { id: 'd', name: 'Dee' }]
    const end = play(newGame(four, { rounds: 2, seed: 11 }))
    expect(end.phase).toBe('gameOver')
  })
})
