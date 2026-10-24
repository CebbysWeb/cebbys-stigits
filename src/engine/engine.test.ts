import { describe, expect, it } from 'vitest'
import { canonical, isConnected, legalTargets, normalize, type Stick } from './geometry'
import { DECK_SIZE, SHAPES, SHAPE_CANON, generateShapes } from './shapes'
import { allMoves, applyAction, findMatchingMove, newGame, winnerNames, type GameState } from './game'

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

function play(state: GameState, maxTurns = 5000): GameState {
  for (let i = 0; i < maxTurns && state.phase !== 'gameOver'; i++) {
    if (state.phase === 'roundOver') {
      state = applyAction(state, { type: 'nextRound', playerId: 'a' })
      continue
    }
    // Greedy bot: take a matching move, else a varied non-matching one so it does not oscillate.
    const moves = allMoves(state)
    const move = findMatchingMove(state) ?? moves[(i * 7919) % moves.length]
    state = applyAction(state, { type: 'move', playerId: state.players[state.current].id, ...move })
  }
  return state
}

describe('standard variant', () => {
  it('deals five cards each and sets the pattern', () => {
    const s = newGame(players, { variant: 'standard', rounds: 1, seed: 1 })
    expect(s.players.map((p) => p.hand.length)).toEqual([5, 5])
    expect(s.deck.length).toBe(55 - 1 - 10)
    expect(s.pattern.length).toBe(5)
  })

  it('rejects moves out of turn and illegal moves', () => {
    const s = newGame(players, { variant: 'standard', rounds: 1, seed: 1 })
    const move = allMoves(s)[0]
    expect(() => applyAction(s, { type: 'move', playerId: 'b', ...move })).toThrow(/turn/)
    expect(() => applyAction(s, { type: 'move', playerId: 'a', index: 0, to: H(99, 99) })).toThrow()
  })

  it('draws a card when the mover cannot match', () => {
    const s = newGame(players, { variant: 'standard', rounds: 1, seed: 3 })
    // Give both players a card that differs from the pattern the move creates.
    const move = allMoves(s)[0]
    const after = s.pattern.map((st, i) => (i === move.index ? move.to : st))
    const unreachable = SHAPE_CANON.findIndex((c) => c !== canonical(after))
    s.players[0].hand = [unreachable]
    s.players[1].hand = [unreachable]
    const next = applyAction(s, { type: 'move', playerId: 'a', ...move })
    expect(next.players[0].hand.length).toBe(2)
    expect(next.current).toBe(1)
  })

  it('lets the mover and others play a matching card', () => {
    const s = newGame(players, { variant: 'standard', rounds: 1, seed: 5 })
    const move = allMoves(s)[0]
    const after = canonical(s.pattern.map((st, i) => (i === move.index ? move.to : st)))
    const card = SHAPE_CANON.indexOf(after)
    s.players[0].hand = [card, 0, 1]
    s.players[1].hand = [card, 2]
    const next = applyAction(s, { type: 'move', playerId: 'a', ...move })
    expect(next.players[0].hand).toEqual([0, 1])
    expect(next.players[1].hand).toEqual([2])
    expect(next.lastPlayed.length).toBe(2)
  })

  it('scores minus points when a hand empties', () => {
    const s = newGame(players, { variant: 'standard', rounds: 1, seed: 5 })
    const move = allMoves(s)[0]
    const card = SHAPE_CANON.indexOf(canonical(s.pattern.map((st, i) => (i === move.index ? move.to : st))))
    s.players[0].hand = [card]
    s.players[1].hand = [card === 0 ? 1 : 0, 2, 3]
    s.players[1].hand = s.players[1].hand.filter((c) => c !== card)
    const next = applyAction(s, { type: 'move', playerId: 'a', ...move })
    expect(next.phase).toBe('gameOver')
    expect(next.players[0].score).toBe(0)
    expect(next.players[1].score).toBe(-next.players[1].hand.length)
    expect(winnerNames(next)).toEqual(['Ann'])
  })

  it('plays a full multi-round game to a scored finish', () => {
    const end = play(newGame(players, { variant: 'standard', rounds: 3, seed: 42 }))
    expect(end.phase).toBe('gameOver')
    expect(end.round).toBe(3)
    expect(end.players.every((p) => p.score <= 0)).toBe(true)
  })
})

describe('plus variant', () => {
  it('grants an extra move after a match and refills at turn end', () => {
    const s = newGame(players, { variant: 'plus', rounds: 1, seed: 7 })
    const move = allMoves(s)[0]
    const card = SHAPE_CANON.indexOf(canonical(s.pattern.map((st, i) => (i === move.index ? move.to : st))))
    s.players[0].hand = [card, ...s.players[0].hand.filter((c) => c !== card)].slice(0, 5)
    const next = applyAction(s, { type: 'move', playerId: 'a', ...move })
    expect(next.current).toBe(0)
    expect(next.players[0].pile).toEqual([card])
    expect(next.players[0].hand.length).toBe(4)
  })

  it('ends when a player cannot refill and scores piles', () => {
    const end = play(newGame(players, { variant: 'plus', rounds: 1, seed: 9 }))
    expect(end.phase).toBe('gameOver')
    expect(end.players.map((p) => p.score)).toEqual(end.players.map((p) => p.pile.length))
  })

  it('plays a full four-player game', () => {
    const four = [...players, { id: 'c', name: 'Cid' }, { id: 'd', name: 'Dee' }]
    const end = play(newGame(four, { variant: 'plus', rounds: 2, seed: 11 }))
    expect(end.phase).toBe('gameOver')
  })
})
