import './style.css'
import { legalTargets } from './engine/geometry'
import { allMoves, findMatchingMove, winnerNames, type GameState } from './engine/game'
import { ClientSession, HostSession, isBot, type Session, type Snapshot } from './net/session'
import { boardSvg, cardSvg, matchstick, midpoint } from './ui/svg'
import { HandView } from './ui/hand'
import type { Stick } from './engine/geometry'

const app = document.querySelector<HTMLDivElement>('#app')!

let session: Session | null = null
let snapshot: Snapshot | null = null
let selected: number | null = null
const hand = new HandView()
// Opponents' hands, smaller and not draggable, keyed by player id.
const seatHands = new Map<string, HandView>()
// Where opponents sit, by player count, in turn order after me.
const SEAT_LAYOUT: Record<number, string[]> = { 1: [], 2: ['top'], 3: ['left', 'right'], 4: ['left', 'top', 'right'] }
// The stick being dragged on the board, and the target it would snap to on release.
let drag: { index: number; pointerId: number; targets: Stick[]; snap: number | null } | null = null
let status = ''

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function storedName(): string {
  try {
    return localStorage.getItem('stigits-name') ?? ''
  } catch {
    return ''
  }
}

function joinCodeFromUrl(): string | null {
  const m = location.hash.match(/join=([A-Za-z0-9]+)/)
  return m ? m[1].toUpperCase() : null
}

function shareLink(code: string): string {
  return `${location.origin}${location.pathname}#join=${code}`
}

let toastTimer = 0
function toast(message: string): void {
  let el = document.querySelector<HTMLDivElement>('.toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    document.body.append(el)
  }
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3000)
}

const events = {
  onSnapshot(s: Snapshot) {
    const prevMove = snapshot?.game?.lastMove
    snapshot = s
    if (s.game?.lastMove !== prevMove) selected = null
    // Rebuilding the board mid-drag would drop the stick; endDrag renders instead.
    if (!drag) render()
  },
  onError: toast,
  onDisconnect() {
    status = 'Lost connection to the host. Reload the page to rejoin.'
    snapshot = null
    session = null
    render()
  },
}

async function connect(mode: 'host' | 'join' | 'practice', code?: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#name')
  const name = input?.value.trim() || 'Player'
  try {
    localStorage.setItem('stigits-name', name)
  } catch {
    /* storage unavailable */
  }
  if (mode === 'practice') {
    session = HostSession.local(name, events)
    events.onSnapshot(structuredClone((session as HostSession).snapshot))
    return
  }
  status = mode === 'host' ? 'Opening a game…' : `Joining ${code}…`
  render()
  try {
    session = mode === 'host' ? await HostSession.create(name, events) : await ClientSession.join(code!, name, events)
    status = ''
    if (session instanceof HostSession) events.onSnapshot(structuredClone(session.snapshot))
  } catch (err) {
    status = ''
    toast((err as Error).message || String(err))
    render()
  }
}

function render(): void {
  if (!session || !snapshot) app.innerHTML = renderHome()
  else if (!snapshot.game) app.innerHTML = renderLobby(snapshot)
  else {
    const g = snapshot.game
    app.innerHTML = renderGame(snapshot, g)
    const me = g.players.find((p) => p.id === session!.myId)
    const slot = app.querySelector('#hand-slot')
    if (slot && me) {
      slot.replaceWith(hand.el)
      hand.update(me.hand)
    }
    for (const p of g.players) {
      const holder = app.querySelector<HTMLElement>(`.seat-fan[data-seat="${CSS.escape(p.id)}"]`)
      if (!holder) continue
      let view = seatHands.get(p.id)
      if (!view) seatHands.set(p.id, (view = new HandView({ interactive: false, minCard: 30, maxCard: 46 })))
      // Side seats are rotated, so their fan runs along the seat's height.
      const side = holder.closest('.seat-left, .seat-right')
      if (side) holder.style.width = `${side.clientHeight - 8}px`
      holder.append(view.el)
      view.update(p.hand)
    }
  }
}

function renderHome(): string {
  const code = joinCodeFromUrl()
  return `<main class="home">
    <h1>Stigits</h1>
    <p class="tagline">Move one matchstick. Match your cards. Empty your hand.</p>
    <label>Your name <input id="name" maxlength="20" value="${esc(storedName())}" placeholder="Player"/></label>
    ${status ? `<p class="status">${esc(status)}</p>` : code
      ? `<button class="primary" data-act="join" data-code="${code}">Join game ${code}</button>
         <button class="link" data-act="clear-join">Host my own game instead</button>`
      : `<button class="primary" data-act="host">Host game</button>
         <button data-act="practice">Practice vs bots (offline)</button>
         <div class="row"><input id="code" maxlength="5" placeholder="CODE"/><button data-act="join-code">Join</button></div>`}
    <details class="rules"><summary>How to play</summary>
      <p>On your turn move <b>one</b> stick to a new spot. It must touch the others so the pattern stays in one piece.
      If the sticks now form the shape on one of your cards (rotated or mirrored counts), that card is played.</p>
      <p><b>Standard:</b> anyone holding the new shape plays one card; if you didn't match, you draw.
      First to an empty hand ends the round; everyone else gets −1 per card left.</p>
      <p><b>Plus:</b> each match gives you another move. Refill to 5 at the end of your turn.
      When someone can't refill, the round ends and each played card is worth +1.</p>
    </details>
  </main>`
}

function renderLobby(s: Snapshot): string {
  const host = session instanceof HostSession
  const link = shareLink(s.code)
  const players = s.players.map((p) => `<li>${isBot(p.id) ? '🤖 ' : ''}${esc(p.name)}${p.id === session!.myId ? ' (you)' : ''}${p.id === 'host' ? ' ★' : ''}${
    host && isBot(p.id) ? ` <button class="link" data-act="remove" data-id="${esc(p.id)}">remove</button>` : ''}</li>`)
  const local = host && (session as HostSession).isLocal
  return `<main class="lobby">
    <h1>Stigits</h1>
    ${local ? '<p class="status">Offline practice: add up to 3 bots, then start.</p>' : `<section class="share">
      <p>Share this link with your friends:</p>
      <div class="row"><input readonly value="${esc(link)}" id="share"/><button data-act="copy">Copy</button></div>
      <p class="code">Code <b>${s.code}</b></p>
    </section>`}
    <section><h2>Players (${s.players.length}/4)</h2><ul class="players">${players.join('')}</ul></section>
    ${host ? `<section class="options">
      <label>Variant <select id="variant">
        <option value="standard" ${s.variant === 'standard' ? 'selected' : ''}>Standard</option>
        <option value="plus" ${s.variant === 'plus' ? 'selected' : ''}>Plus</option></select></label>
      <label>Rounds <select id="rounds">${[1, 2, 3, 5, 7].map((n) => `<option ${n === s.rounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${s.players.length < 4 ? '<button data-act="add-bot">Add a bot 🤖</button>' : ''}
      <button class="primary" data-act="start" ${s.players.length < 2 ? 'disabled' : ''}>Start game</button>
      ${s.players.length < 2 ? '<p class="hint">Waiting for a friend to join, or add a bot…</p>' : ''}
    </section>` : `<p class="status">Waiting for the host to start (${s.variant === 'plus' ? 'Plus' : 'Standard'}, ${s.rounds} rounds)…</p>`}
  </main>`
}

function renderGame(s: Snapshot, g: GameState): string {
  const me = g.players.findIndex((p) => p.id === session!.myId)
  const myTurn = g.phase === 'playing' && g.current === me
  const targets = myTurn && selected !== null ? legalTargets(g.pattern, selected) : []
  const turnText = g.phase !== 'playing' ? 'Round over'
    : myTurn ? (selected === null ? 'Your turn — drag a stick to a new spot' : 'Drop it on a green spot')
    : `${esc(g.players[g.current].name)} is moving…`
  const scoreLabel = g.variant === 'plus' ? 'pts' : 'minus'

  // Seats follow turn order clockwise from me: the next player sits on my left.
  const seat = (i: number) => {
    const p = g.players[i]
    const online = s.players.find((x) => x.id === p.id)?.connected !== false
    const pos = i === me ? 'bottom' : SEAT_LAYOUT[g.players.length][(i - me + g.players.length) % g.players.length - 1]
    return `<div class="seat seat-${pos} ${i === g.current ? 'active' : ''} ${i === me ? 'me' : ''}">
      <div class="seat-label"><b>${esc(p.name)}${i === me ? ' (you)' : ''}</b>${online ? '' : ' <span class="off">offline</span>'}
        <span class="meta">${p.hand.length} cards · ${g.variant === 'plus' ? `${p.pile.length} played · ` : ''}${p.score} ${scoreLabel}</span></div>
      ${i === me
        ? (p.hand.length ? '<div id="hand-slot"></div>' : '<p class="hint">No cards left!</p>')
        : `<div class="seat-fan" data-seat="${esc(p.id)}"></div>`}
    </div>`
  }

  const lastPlays = g.lastPlayed.map((p) => `<div class="card played" title="${esc(g.players[p.player].name)}">${cardSvg(p.card)}<span>${esc(g.players[p.player].name)}</span></div>`).join('')

  return `<main class="game">
    <header>
      <span>Round ${g.round}/${g.roundsTotal} · ${g.variant === 'plus' ? 'Plus' : 'Standard'} · Deck ${g.deck.length}</span>
      <span class="code">Code ${s.code}</span>
    </header>
    <section class="table-layout">
      ${g.players.map((_, i) => (i === me ? '' : seat(i))).join('')}
      <div class="table">
        <p class="turn ${myTurn ? 'mine' : ''}">${turnText}</p>
        ${boardSvg({ pattern: g.pattern, selected: myTurn ? selected : null, targets, lastTo: g.lastMove?.to ?? null, interactive: myTurn }, camViewBox(g))}
        ${lastPlays ? `<div class="last"><span>Just matched:</span>${lastPlays}</div>` : ''}
      </div>
      ${seat(me)}
    </section>
    <details class="log"><summary>Game log</summary><ol>${g.log.slice(-30).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ol></details>
    ${g.phase === 'playing' ? '' : renderRoundOver(g)}
  </main>`
}

function renderRoundOver(g: GameState): string {
  const host = session instanceof HostSession
  const over = g.phase === 'gameOver'
  const rows = [...g.players].sort((a, b) => b.score - a.score)
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${g.variant === 'plus' ? p.pile.length : p.hand.length}</td><td>${p.score}</td></tr>`)
  return `<div class="overlay"><div class="dialog">
    <h2>${over ? `🏆 ${winnerNames(g).map(esc).join(' & ')} wins!` : `Round ${g.round} over`}</h2>
    <table><thead><tr><th>Player</th><th>${g.variant === 'plus' ? 'Played' : 'Left in hand'}</th><th>Total</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    ${host ? (over ? '<button class="primary" data-act="lobby">Back to lobby</button>' : '<button class="primary" data-act="next">Next round</button>')
      : `<p class="hint">Waiting for the host…</p>`}
  </div></div>`
}

app.addEventListener('click', async (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]')
  if (!el) return
  switch (el.dataset.act) {
    case 'host': return connect('host')
    case 'join': return connect('join', el.dataset.code)
    case 'practice': return connect('practice')
    case 'add-bot': return (session as HostSession).addBot()
    case 'remove': return (session as HostSession).removePlayer(el.dataset.id!)
    case 'join-code': {
      const code = document.querySelector<HTMLInputElement>('#code')!.value.trim().toUpperCase()
      if (code) return connect('join', code)
      return
    }
    case 'clear-join':
      history.replaceState(null, '', location.pathname)
      return render()
    case 'copy': {
      const link = document.querySelector<HTMLInputElement>('#share')!.value
      try {
        await navigator.clipboard.writeText(link)
        toast('Link copied!')
      } catch {
        document.querySelector<HTMLInputElement>('#share')!.select()
      }
      return
    }
    case 'start': return (session as HostSession).start()
    case 'next': return session!.send({ type: 'nextRound', playerId: session!.myId })
    case 'lobby': return (session as HostSession).backToLobby()
  }
})

// Board camera, in SVG units (y down). The view drifts back to the sticks'
// centre of mass unless the player is panning or has just let go.
const BOARD_ASPECT = 0.75
const RECENTER_DELAY_MS = 900
const RECENTER_SECONDS = 1.2
const cam = { x: 0, y: 0, w: 8, ready: false, idleSince: 0 }
let pan: { pointerId: number; startX: number; startY: number; camX: number; camY: number } | null = null

function camTarget(g: GameState): { x: number; y: number; w: number } {
  const mids = g.pattern.map(midpoint)
  const x = mids.reduce((a, m) => a + m.x, 0) / mids.length
  const y = -mids.reduce((a, m) => a + m.y, 0) / mids.length
  const xs = mids.map((m) => m.x)
  const ys = mids.map((m) => m.y)
  // Fit the pattern plus room for any target around it.
  const w = Math.max(8, Math.max(...xs) - Math.min(...xs) + 4, (Math.max(...ys) - Math.min(...ys) + 4) / BOARD_ASPECT)
  return { x, y, w }
}

function camViewBox(g: GameState): string {
  if (!cam.ready) {
    Object.assign(cam, camTarget(g))
    cam.ready = true
  }
  const h = cam.w * BOARD_ASPECT
  return `${cam.x - cam.w / 2} ${cam.y - h / 2} ${cam.w} ${h}`
}

let lastFrame = performance.now()
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  const g = snapshot?.game
  const board = app.querySelector<SVGSVGElement>('.board')
  if (g && board && !pan && !drag && now - cam.idleSince > RECENTER_DELAY_MS) {
    const t = camTarget(g)
    const k = 1 - Math.exp(-dt / (RECENTER_SECONDS / 3))
    cam.x += (t.x - cam.x) * k
    cam.y += (t.y - cam.y) * k
    cam.w += (t.w - cam.w) * k
    board.setAttribute('viewBox', camViewBox(g))
  }
  if (!g) cam.ready = false
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Panning: drag anywhere on the board that is not a movable stick.
app.addEventListener('pointerdown', (e) => {
  const board = (e.target as Element).closest<SVGSVGElement>('.board')
  if (!board || drag || pan || (e.target as Element).closest('.hit[data-stick]')) return
  pan = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y }
  board.setPointerCapture(e.pointerId)
  board.classList.add('panning')
})
app.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.pointerId) return
  const board = app.querySelector<SVGSVGElement>('.board')
  const g = snapshot?.game
  if (!board || !g) return
  const unitsPerPx = cam.w / board.clientWidth
  const t = camTarget(g)
  const limit = t.w * 0.75 // never lose the pattern entirely
  cam.x = Math.max(t.x - limit, Math.min(t.x + limit, pan.camX - (e.clientX - pan.startX) * unitsPerPx))
  cam.y = Math.max(t.y - limit, Math.min(t.y + limit, pan.camY - (e.clientY - pan.startY) * unitsPerPx))
  board.setAttribute('viewBox', camViewBox(g))
})
const endPan = (e: PointerEvent) => {
  if (!pan || e.pointerId !== pan.pointerId) return
  pan = null
  cam.idleSince = performance.now()
  app.querySelector('.board')?.classList.remove('panning')
}
app.addEventListener('pointerup', endPan)
app.addEventListener('pointercancel', endPan)

// Drag and drop on the board: grab a stick, it follows the pointer, and it snaps
// to the nearest legal spot. Releasing away from every spot puts it back.
const SNAP_DISTANCE = 0.6

function isMyTurn(): boolean {
  const g = snapshot?.game
  return !!g && !!session && g.phase === 'playing' && g.players[g.current].id === session.myId
}

app.addEventListener('pointerdown', (e) => {
  const hit = (e.target as Element).closest<SVGElement>('.hit[data-stick]')
  const g = snapshot?.game
  if (!hit || !g || !isMyTurn() || drag) return
  const index = Number(hit.dataset.stick)
  const targets = legalTargets(g.pattern, index)
  if (!targets.length) {
    toast('That stick holds the pattern together — pick another.')
    return
  }
  e.preventDefault()
  selected = index
  drag = { index, pointerId: e.pointerId, targets, snap: null }
  render()
  const board = app.querySelector<SVGSVGElement>('.board')!
  board.classList.add('dragging')
  board.setPointerCapture(e.pointerId)
  updateDrag(board, e)
})

app.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return
  const board = app.querySelector<SVGSVGElement>('.board')
  if (board) updateDrag(board, e)
})

function updateDrag(board: SVGSVGElement, e: PointerEvent): void {
  const d = drag!
  const ctm = board.getScreenCTM()
  if (!ctm) return
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
  const at = { x: p.x, y: -p.y } // back to lattice coordinates (y up)

  d.snap = null
  let best = SNAP_DISTANCE
  d.targets.forEach((t, i) => {
    const m = midpoint(t)
    const dist = Math.hypot(m.x - at.x, m.y - at.y)
    if (dist < best) {
      best = dist
      d.snap = i
    }
  })
  board.querySelectorAll('.ghost.hot').forEach((g) => g.classList.remove('hot'))
  if (d.snap !== null) board.querySelector(`.ghost[data-ghost="${d.snap}"]`)?.classList.add('hot')

  // Snapped: preview the stick in place. Otherwise it floats under the pointer.
  const dir = snapshot!.game!.pattern[d.index].d
  const floating: Stick = dir === 'H' ? { x: at.x - 0.5, y: at.y, d: 'H' } : { x: at.x, y: at.y - 0.5, d: 'V' }
  const shown = d.snap !== null ? d.targets[d.snap] : floating
  board.querySelector('.drag-layer')!.innerHTML = matchstick(shown, `class="stick held ${d.snap !== null ? 'snapped' : ''}"`)
}

function endDrag(e: PointerEvent, commit: boolean): void {
  const d = drag
  if (!d || e.pointerId !== d.pointerId) return
  drag = null
  selected = null
  cam.idleSince = performance.now()
  if (commit && d.snap !== null && session) {
    session.send({ type: 'move', playerId: session.myId, index: d.index, to: d.targets[d.snap] })
  }
  render()
}

app.addEventListener('pointerup', (e) => endDrag(e, true))
app.addEventListener('pointercancel', (e) => endDrag(e, false))

app.addEventListener('change', (e) => {
  if (!(session instanceof HostSession)) return
  const id = (e.target as Element).id
  if (id === 'variant' || id === 'rounds') {
    const variant = document.querySelector<HTMLSelectElement>('#variant')!.value as 'standard' | 'plus'
    const rounds = Number(document.querySelector<HTMLSelectElement>('#rounds')!.value)
    session.configure(variant, rounds)
  }
})

window.addEventListener('beforeunload', (e) => {
  if (session instanceof HostSession && snapshot?.game) e.preventDefault()
})

// Test hook: plays a move for the local player (matching if possible).
declare global {
  interface Window {
    __stigits?: { snapshot: () => Snapshot | null; myId: () => string | null; handOrder: () => number[]; autoMove: () => boolean }
  }
}
window.__stigits = {
  snapshot: () => snapshot,
  myId: () => session?.myId ?? null,
  handOrder: () => hand.cardOrder,
  autoMove: () => {
    const g = snapshot?.game
    if (!g || !session || g.phase !== 'playing' || g.players[g.current].id !== session.myId) return false
    const moves = allMoves(g)
    const move = findMatchingMove(g) ?? moves[Math.floor(Math.random() * moves.length)]
    session.send({ type: 'move', playerId: session.myId, ...move })
    return true
  },
}

render()
