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
  it('deals 5 cards to each of up to 12 players, never a duplicate within a hand', () => {
    const s = newGame(Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rounds: 1, seed: 3 })
    for (const p of s.players) {
      expect(p.hand.length).toBe(5)
      expect(new Set(p.hand).size).toBe(5)
    }
    expect(() => newGame(Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rounds: 1 })).toThrow()
  })
})

describe('table settings', () => {
  const two = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  it('empty deck: the pile holds N cards on top of the hands, even more than one deck', () => {
    let s = newGame(two, { rounds: 1, seed: 2, pile: 120 })
    expect(s.pileLeft).toBe(120)
    let drawn = 0
    while (s.phase === 'playing') {
      const p = s.players[s.current]
      // Play away the whole hand each turn, so the pile empties quickly.
      drawn += p.hand.length
      p.pile.push(...p.hand.splice(0))
      s = applyAction(s, { type: 'endTurn', playerId: p.id })
      for (const q of s.players) expect(new Set(q.hand).size).toBe(q.hand.length)
    }
    expect(s.pileLeft).toBe(0)
    // The pile is drawn dry; the game ends as soon as one hand empties, leaving the other full.
    expect(drawn).toBe(10 + 120 - 5)
  })
  it('uses the chosen wrong-call penalty', () => {
    for (const penalty of [0, 2]) {
      const s = newGame(two, { rounds: 1, seed: 2, penalty, mode: 'rounds' })
      s.players[1].score = 5
      const wrong = s.players[1].hand.find((c) => SHAPE_CANON[c] !== canonical(s.pattern))!
      const next = applyAction(s, { type: 'claim', playerId: 'b', card: wrong, seen: s.moveCount })
      expect(next.players[1].score).toBe(5 - penalty)
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
    // Any stick but the one just placed (which may be placed again to fix a slip).
    const other = allMoves(s).find((m) => m.index !== s.adjust!.index)!
    expect(() => applyAction(s, { type: 'move', playerId: s.players[0].id, ...other })).toThrow(/end your turn/)
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
    const start = newGame(players, { rounds: 1, seed: 5 })
    expect(start.turn).toBe(1)
    const next = end(start)
    expect(next.current).toBe(1)
    expect(next.turn).toBe(2)
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

  it('stops refilling once the pile runs out, but play goes on', () => {
    let s = moveTo(newGame(players, { rounds: 1, seed: 5 }))
    s.pileLeft = 2
    s.players[0].hand = s.players[0].hand.slice(0, 2)
    s = end(s)
    expect(s.phase).toBe('playing')
    expect(s.pileLeft).toBe(0)
    expect(s.players[0].hand.length).toBe(4)
    expect(s.current).toBe(1)
  })

  it('the first player to play out their hand once the pile is gone ends the game', () => {
    let s = newGame([...players, { id: 'c', name: 'Cy' }], { rounds: 1, seed: 5 })
    s.pileLeft = 0
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[1].hand = [card]
    s = claim(s, s.players[1].id, card)
    expect(s.phase).toBe('gameOver')
  })

  it('optionally takes a point per card left in hand', () => {
    let s = newGame(players, { rounds: 1, seed: 5, handPenalty: true })
    s.pileLeft = 0
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[0].hand = [card]
    s.players[1].hand = s.players[1].hand.slice(0, 3)
    s.players[1].score = 4
    s = claim(s, s.players[0].id, card)
    expect(s.phase).toBe('gameOver')
    expect(s.players[0].score).toBe(1)
    expect(s.players[1].score).toBe(1)
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
    const s = newGame(players, { rounds: 1, seed: 5, mode: 'rounds' })
    const canon = canonical(s.pattern)
    const wrong = s.players[0].hand.find((c) => SHAPE_CANON[c] !== canon)!
    s.players[0].score = 3
    const next = claim(s, 'a', wrong)
    expect(next.players[0].score).toBe(2)
    // Scores never go below zero.
    expect(claim({ ...next, players: next.players.map((p, i) => (i ? p : { ...p, score: 0 })) }, 'a', wrong).players[0].score).toBe(0)
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
  it('empty deck: plays until nothing is left to draw; most played cards wins', () => {
    const end = play(newGame(players, { rounds: 3, seed: 42 }))
    expect(end.phase).toBe('gameOver')
    expect(end.round).toBe(1)
    expect(end.pileLeft).toBe(0)
    expect(end.players.every((p) => p.score === p.pile.length)).toBe(true)
  })

  it('empty deck: a wrong card goes back to the pile, is discarded, or costs a point', () => {
    for (const [miss, inHand, pile, score] of [['keep', true, 50, 1], ['toPile', false, 51, 1], ['discard', false, 50, 1], ['point', true, 50, 0]] as const) {
      const s = newGame(players, { rounds: 1, seed: 5, miss, pile: 50 })
      s.players[0].score = 1
      const wrong = s.players[0].hand.find((c) => SHAPE_CANON[c] !== canonical(s.pattern))!
      const next = claim(s, 'a', wrong)
      expect(next.players[0].hand.includes(wrong)).toBe(inHand)
      expect(next.pileLeft).toBe(pile)
      expect(next.players[0].score).toBe(score)
    }
  })

  it('rounds: a round is one turn each, the deck never runs out', () => {
    let s = newGame(players, { rounds: 4, seed: 7, mode: 'rounds' })
    for (let t = 0; t < 7; t++) {
      expect(s.round).toBe(Math.floor(t / 2) + 1)
      s = applyAction(s, { type: 'endTurn', playerId: s.players[s.current].id })
      expect(s.players.every((p) => p.hand.length === 5)).toBe(true)
    }
    s = applyAction(s, { type: 'endTurn', playerId: s.players[s.current].id })
    expect(s.phase).toBe('gameOver')
    expect(s.round).toBe(4)
  })

  it('rounds: hands refill forever from a reshuffled deck', () => {
    let s = newGame(players, { rounds: 40, seed: 9, mode: 'rounds' })
    while (s.phase === 'playing') {
      const p = s.players[s.current]
      // Play away every card the cheap way, so the deck must be reshuffled.
      p.pile.push(...p.hand.splice(0))
      s = applyAction(s, { type: 'endTurn', playerId: p.id })
    }
    expect(s.round).toBe(40)
    expect(s.players.every((p) => p.hand.length === 5)).toBe(true)
  })

  it('plays a full four-player game', () => {
    const four = [...players, { id: 'c', name: 'Cid' }, { id: 'd', name: 'Dee' }]
    const end = play(newGame(four, { rounds: 2, seed: 11 }))
    expect(end.phase).toBe('gameOver')
  })
})

describe('fixing a slipped drop', () => {
  const start = () => newGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rounds: 1, seed: 5 })
  const moveStick = (s: GameState, index: number, to: Stick) => applyAction(s, { type: 'move', playerId: 'a', index, to })

  it('lets the mover place the same stick again without spending a move', () => {
    const s = moveTo(start())
    const index = s.adjust!.index
    const elsewhere = legalTargets(s.pattern, index).find((t) => !(t.x === s.adjust!.from.x && t.y === s.adjust!.from.y && t.d === s.adjust!.from.d))!
    const again = moveStick(s, index, elsewhere)
    expect(again.movesLeft).toBe(0)
    expect(again.pattern[index]).toEqual(elsewhere)
    expect(again.lastMove!.from).toEqual(s.adjust!.from)
    // Any other stick still needs a move.
    const other = (index + 1) % s.pattern.length
    const t = legalTargets(again.pattern, other)[0]
    if (t) expect(() => moveStick(again, other, t)).toThrow(/move again/)
  })

  it('putting the stick back undoes the move', () => {
    const s0 = start()
    const s = moveTo(s0)
    const back = moveStick(s, s.adjust!.index, s.adjust!.from)
    expect(back.pattern).toEqual(s0.pattern)
    expect(back.movesLeft).toBe(1)
    expect(back.turnMoved).toBe(false)
    expect(back.adjust).toBeNull()
  })

  it('a matched card or the end of the turn sets the stick', () => {
    let s = start()
    const card = s.players[1].hand[0]
    s = moveTo(s, card)
    if (matchFor(s, 1) !== undefined) {
      expect(claim(s, 'b', matchFor(s, 1)!).adjust).toBeNull()
    }
    const ended = applyAction(moveTo(start()), { type: 'endTurn', playerId: 'a' })
    expect(ended.adjust).toBeNull()
  })
})

describe('singleplayer', () => {
  const solo = [{ id: 'a', name: 'Ann' }]
  it('moves without limit, and a turn that moves without playing costs a point (not below 0)', () => {
    let s = newGame(solo, { rounds: 1, seed: 5, solo: true })
    s.players[0].score = 1
    for (let k = 0; k < 3; k++) {
      const m = allMoves(s).find((x) => x.index !== s.adjust?.index)!
      s = applyAction(s, { type: 'move', playerId: 'a', index: m.index, to: m.to })
    }
    expect(s.moveCount).toBe(3)
    s = applyAction(s, { type: 'endTurn', playerId: 'a' })
    expect(s.players[0].score).toBe(0)
    const m = allMoves(s)[0]
    s = applyAction(s, { type: 'move', playerId: 'a', index: m.index, to: m.to })
    s = applyAction(s, { type: 'endTurn', playerId: 'a' })
    expect(s.players[0].score).toBe(0)
  })
  it('a turn that plays a card costs nothing', () => {
    let s = newGame(solo, { rounds: 1, seed: 5, solo: true })
    const m = allMoves(s)[0]
    s = applyAction(s, { type: 'move', playerId: 'a', index: m.index, to: m.to })
    const card = SHAPE_CANON.indexOf(canonical(s.pattern))
    s.players[0].hand[0] = card
    s = applyAction(s, { type: 'claim', playerId: 'a', card, seen: s.moveCount })
    s = applyAction(s, { type: 'endTurn', playerId: 'a' })
    expect(s.players[0].score).toBe(1)
  })
})
