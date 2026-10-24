import './style.css'
import { legalTargets } from './engine/geometry'
import { allMoves, findMatchingMove, matchingCard, PILE_MAX, PILE_MIN, PILE_STEP, winnerNames, type GameState, type Settings } from './engine/game'
import { ClientSession, HostSession, isBot, type Session, type Snapshot, MAX_PLAYERS } from './net/session'
import { boardSvg, midpoint, stickSvg } from './ui/svg'
import { HandView } from './ui/hand'
import { PlayedPile } from './ui/pile'
import type { Stick } from './engine/geometry'

const app = document.querySelector<HTMLDivElement>('#app')!

let session: Session | null = null
let snapshot: Snapshot | null = null
let selected: number | null = null
/** Whether the controls help panel is open; kept across re-renders. */
let helpOpen = false
const pile = new PlayedPile()
const hand = new HandView({ interactive: true, minCard: 76, maxCard: 140, onPlay: playCard })

/** Call a card: it scores if it matches the grid right now, and costs a point if not. */
function playCard(card: number): void {
  const g = snapshot?.game
  if (!g || !session || g.phase !== 'playing') return
  session.send({ type: 'claim', playerId: session.myId, card, seen: g.moveCount })
}
// Opponents' hands, smaller and not draggable, keyed by player id.
const seatHands = new Map<string, HandView>()
// Where opponents sit, by player count, in turn order after me.
/** Opponents split across the left, top and right edges, in clockwise order. */
function seatSides(k: number): string[] {
  if (k <= 3) return [[], ['top'], ['left', 'right'], ['left', 'top', 'right']][k]
  const side = Math.floor(k / 3)
  return [...Array(side).fill('left'), ...Array(k - 2 * side).fill('top'), ...Array(side).fill('right')]
}
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
    const prevClaim = snapshot?.game?.lastClaim?.seq
    snapshot = s
    const c = s.game?.lastClaim
    // A correctly played card flies from the hand that played it to the pile.
    // Find it in its hand now, before the redraw removes it.
    let flight: { card: number; from: DOMRect; opacity: number } | null = null
    if (c && c.seq !== prevClaim && s.game) {
      const who = s.game.players[c.player]
      const mine = who.id === session?.myId
      toast(c.ok ? `${mine ? 'Match! ' : `${who.name} matched! `}+1` : `${mine ? 'Not a match' : `${who.name} missed`} −1`)
      if (mine && !c.ok) hand.flash(c.card, 'wrong')
      const el = c.ok ? document.querySelector<HTMLElement>(`.hand-card[data-card="${c.card}"]`) : null
      if (el) {
        const fan = el.closest<HTMLElement>('.fan')
        flight = { card: c.card, from: el.getBoundingClientRect(), opacity: fan ? Number(getComputedStyle(fan).opacity) : 1 }
        el.style.visibility = 'hidden'
      }
    }
    if (s.game?.lastMove !== prevMove) selected = null
    // Rebuilding the board mid-drag would drop the stick; endDrag renders instead.
    if (!drag) render()
    else pile.update(s.game?.played.map((p) => p.card) ?? [])
    if (flight) pile.fly(flight.card, flight.from, flight.opacity)
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
      hand.allowRotate = g.settings.rotate
      hand.allowMirror = g.settings.mirror
      hand.update(me.hand)
    }
    app.querySelector('#pile-slot')?.replaceWith(pile.el)
    pile.update(g.played.map((p) => p.card))
    for (const p of g.players) {
      const holder = app.querySelector<HTMLElement>(`.seat-fan[data-seat="${CSS.escape(p.id)}"]`)
      if (!holder) continue
      let view = seatHands.get(p.id)
      if (!view) seatHands.set(p.id, (view = new HandView({ interactive: false, minCard: 30, maxCard: 46, faceDown: true })))
      // Side seats are rotated, so their fan runs along the seat's height.
      const side = holder.closest('.seat-left, .seat-right')
      if (side) holder.style.width = `${(side as HTMLElement).clientHeight - 8}px`
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
      <p>On your turn move <b>one</b> stick to a new spot. It must touch the others so the pattern stays in one piece.</p>
      <p>Spot the shape on one of your cards on the grid (rotated or mirrored counts)? Drag that card up onto the
      board to play it, at any time, even on someone else's turn. A match scores <b>+1</b>; a wrong call costs <b>−1</b>.</p>
      <p><b>Standard:</b> first to an empty hand ends the round; everyone else gets −1 per card left.</p>
      <p><b>Plus:</b> each played card is replaced from the deck. The round ends when the deck runs out.</p>
    </details>
  </main>`
}

function renderLobby(s: Snapshot): string {
  const host = session instanceof HostSession
  const local = host && (session as HostSession).isLocal
  const n = s.players.length
  const set = s.settings
  const full = n >= MAX_PLAYERS

  const players = s.players.map((p) => `<li>
      <span class="avatar ${isBot(p.id) ? 'bot' : ''}">${esc(p.name.slice(0, 1).toUpperCase() || '?')}</span>
      <span class="pl-name">${esc(p.name)}${p.id === session!.myId ? ' <em>(you)</em>' : ''}${isBot(p.id) ? ' <em>· bot</em>' : ''}</span>
      ${p.id === 'host' ? '<span class="tag">host</span>' : ''}
      ${host && isBot(p.id) ? `<button class="icon" data-act="remove" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}
    </li>`).join('')

  // Every control is rendered for everyone; only the host can change them.
  const lock = host ? '' : 'disabled'
  const select = (key: keyof Settings, opts: [string | number, string, boolean?][]) =>
    `<select data-setting="${key}" ${lock}>${opts.map(([v, label, off]) =>
      `<option value="${v}" ${String(set[key]) === String(v) ? 'selected' : ''} ${off ? 'disabled' : ''}>${label}</option>`).join('')}</select>`
  const toggle = (key: keyof Settings) =>
    `<input type="checkbox" class="switch" data-setting="${key}" ${set[key] ? 'checked' : ''} ${lock}/>`
  const row = (label: string, hint: string, control: string) =>
    `<label class="setting"><span><b>${label}</b><small>${hint}</small></span>${control}</label>`

  const rounds = set.mode === 'rounds'
  const modes: [Settings['mode'], string, string][] = [
    ['emptyDeck', 'Empty Deck', 'Refill your hand from a shared pile. When it runs out, most cards played wins.'],
    ['rounds', 'Rounds', 'Cards never run out. Everyone takes one turn per round. Top score wins.'],
  ]
  const pile = `<div class="pile-picker">
      <div class="stepper">
        <button type="button" data-act="pile-step" data-step="-${PILE_STEP}" aria-label="${PILE_STEP} fewer cards" ${!host || set.pile <= PILE_MIN ? 'disabled' : ''}>−</button>
        <output id="pile-value"><b>${set.pile}</b><span>cards</span></output>
        <button type="button" data-act="pile-step" data-step="${PILE_STEP}" aria-label="${PILE_STEP} more cards" ${!host || set.pile >= PILE_MAX ? 'disabled' : ''}>+</button>
      </div>
      <input type="range" class="pile-range" min="${PILE_MIN}" max="${PILE_MAX}" step="${PILE_STEP}" value="${set.pile}"
        data-setting="pile" aria-label="Cards in the pile" style="--fill: ${((set.pile - PILE_MIN) / (PILE_MAX - PILE_MIN)) * 100}%" ${lock}/>
      <div class="pile-scale"><span>${PILE_MIN}</span><span>${PILE_MAX}</span></div>
    </div>`
  const settings = `
    <div class="modes" role="radiogroup" aria-label="Game mode">${modes.map(([m, label, about]) => `
      <label class="mode ${set.mode === m ? 'on' : ''}">
        <input type="radio" name="mode" value="${m}" data-setting="mode" ${set.mode === m ? 'checked' : ''} ${lock}/>
        <b>${label}</b><small>${about}</small>
      </label>`).join('')}</div>
    ${rounds ? row('Rounds', 'Each round, every player takes one turn.', select('rounds', [1, 2, 3, 5, 7, 10].map((r) => [r, String(r)])))
      : `<div class="setting setting-pile"><span><b>Draw pile</b><small>Everyone starts with 5 cards and refills from this pile.</small></span>${pile}</div>`}
    ${row('Turn cards', 'Hold a card and press R or E. Off: picture the turn yourself.', toggle('rotate'))}
    ${row('Flip cards', 'Hold a card and press F. Off: picture the mirror image.', toggle('mirror'))}
    ${rounds ? row('Wrong guess', 'Points lost for playing a card that doesn’t match.', select('penalty', [[0, 'Nothing'], [1, '1 point'], [2, '2 points']]))
      : row('Wrong guess', 'Played cards lost for playing one that doesn’t match.', select('penalty', [[0, 'Nothing'], [1, '1 card'], [2, '2 cards']]))}
    ${row('Move hints', 'Show green spots where a picked-up stick can go.', toggle('hints'))}
    ${row('Bot speed', 'How fast bots move and spot their shapes.', select('botSpeed', [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['quick', 'Quick']]))}`

  return `<main class="lobby">
    <header class="lobby-head">
      <h1>Stigits</h1>
      ${local ? '<p class="status">Offline practice against bots.</p>' : `<div class="share">
        <input readonly value="${esc(shareLink(s.code))}" id="share" aria-label="Invite link"/>
        <button data-act="copy">Copy link</button>
        <span class="code">Code <b>${s.code}</b></span>
      </div>`}
    </header>
    <div class="lobby-grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Players <span class="count">${n}/${MAX_PLAYERS}</span></h2>
          ${host ? `<button data-act="add-bot" ${full ? 'disabled' : ''}>+ Add bot</button>` : ''}
        </div>
        <ul class="players">${players}</ul>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Settings</h2>${host ? '' : '<span class="tag">set by the host</span>'}</div>
        <div class="settings">${settings}</div>
      </section>
    </div>
    <footer class="lobby-foot">
      <p class="hint">${host ? (n < 2 ? 'Waiting for a friend to join, or add a bot…' : 'Ready when you are.') : 'Waiting for the host to start…'}</p>
      ${host ? `<button class="primary start" data-act="start" ${n < 2 ? 'disabled' : ''}>Start game</button>` : ''}
    </footer>
  </main>`
}

function renderGame(s: Snapshot, g: GameState): string {
  const me = g.players.findIndex((p) => p.id === session!.myId)
  const myTurn = g.phase === 'playing' && g.current === me
  const targets = myTurn && selected !== null ? legalTargets(g.pattern, selected) : []
  const turnText = g.phase !== 'playing' ? 'Round over'
    : myTurn ? (g.movesLeft < 1 ? 'Play a matching card to move again — or end your turn'
      : selected !== null ? 'Drop it on a green spot'
      : g.turnMoved ? 'Match! Move another stick' : 'Your turn — move a stick, or play a card if one already matches')
    : `${esc(g.players[g.current].name)} is moving…`

  // Seats follow turn order clockwise from me: the next player sits on my left.
  const seat = (i: number) => {
    const p = g.players[i]
    const online = s.players.find((x) => x.id === p.id)?.connected !== false
    const pos = i === me ? 'bottom' : seatSides(g.players.length - 1)[(i - me + g.players.length) % g.players.length - 1]
    return `<div class="seat seat-${pos} ${i === g.current ? 'active' : ''} ${i === me ? 'me' : ''}">
      <div class="seat-label"><b>${esc(p.name)}${i === me ? ' (you)' : ''}</b>${online ? '' : ' <span class="off">offline</span>'}${i === g.current ? ` <span class="turn-badge">Turn ${g.turn}</span>` : ''}
</div>
      ${i === me && myTurn ? '<button class="primary end-turn" data-act="end-turn">End turn</button>' : ''}
      ${i === me
        ? (p.hand.length ? '<div id="hand-slot"></div>' : '<p class="hint">No cards left!</p>')
        : `<div class="seat-fan" data-seat="${esc(p.id)}"></div>`}
    </div>`
  }


  return `<main class="game">
    <header>
      <span>${g.settings.mode === 'rounds' ? `Rounds · Round ${g.round}/${g.roundsTotal}` : `Empty Deck · ${g.pileLeft} cards in the pile`}</span>
      <span class="code">Code ${s.code}</span>
    </header>
    <aside class="scoreboard">
      <h2>Scores <span class="turn-badge">Turn ${g.turn}</span></h2>
      <ol>${g.players.map((p, i) => {
        const online = s.players.find((x) => x.id === p.id)?.connected !== false
        return `<li class="${i === g.current ? 'active' : ''} ${i === me ? 'me' : ''}">
          <span class="sb-name">${esc(p.name)}${i === me ? ' (you)' : ''}${online ? '' : ' <span class="off">offline</span>'}</span>
          <span class="sb-score">${p.score}</span>
          <span class="sb-meta">${p.pile.length} played · ${p.hand.length} in hand</span>
        </li>`
      }).join('')}</ol>
    </aside>
    <section class="table-layout">
      ${['left', 'top', 'right'].map((side) => {
        const n = g.players.length
        const mine = Array.from({ length: n - 1 }, (_, k) => (me + 1 + k) % n)
          .filter((_, k) => seatSides(n - 1)[k] === side)
        return mine.length ? `<div class="side side-${side}">${mine.map(seat).join('')}</div>` : ''
      }).join('')}
      <div class="table">
        <p class="turn ${myTurn ? 'mine' : ''}">${turnText}</p>
        ${boardSvg({ pattern: g.pattern, selected: myTurn ? selected : null, targets, lastTo: g.lastMove?.to ?? null, interactive: myTurn, hints: g.settings.hints }, camViewBox(g))}
      </div>
      ${seat(me)}
      <div id="pile-slot"></div>
    </section>
    <button class="help-btn" data-act="help" aria-label="Controls">?</button>
    ${helpOpen ? `<div class="help-panel" role="dialog" aria-label="Controls">
      <button class="help-close" data-act="help-close" aria-label="Close">×</button>
      <h2>Controls</h2>
      <ul>
        <li><b>Move a stick:</b> drag it onto a green spot.</li>
        <li><b>Play a card:</b> spot one of your shapes on the grid and drag the card up. +1 if it matches, ${g.settings.penalty ? `−${g.settings.penalty}` : 'no penalty'} if not.</li>
        ${g.settings.rotate ? '<li><b>Turn a held card:</b> R clockwise, E counter-clockwise.</li>' : '<li><b>Turning cards is off</b> at this table — turn shapes in your head.</li>'}
        ${g.settings.mirror ? '<li><b>Mirror a held card:</b> F.</li>' : '<li><b>Mirroring is off</b> at this table — flip shapes in your head.</li>'}
        <li><b>Pan:</b> drag the empty grid.</li>
        <li><b>Reorder:</b> drag cards sideways in your hand.</li>
      </ul>
    </div>` : ''}
    <details class="log"><summary>Game log</summary><ol>${g.log.slice(-30).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ol></details>
    ${g.phase === 'playing' ? '' : renderRoundOver(g)}
  </main>`
}

function renderRoundOver(g: GameState): string {
  const host = session instanceof HostSession
  const over = g.phase === 'gameOver'
  const rows = [...g.players].sort((a, b) => b.score - a.score)
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${p.pile.length}</td><td>${p.score}</td></tr>`)
  const cols = g.settings.mode === 'rounds' ? '<th>Played</th><th>Score</th>' : '<th>Played</th><th>Counted</th>'
  return `<div class="overlay"><div class="dialog">
    <h2>${over ? `🏆 ${winnerNames(g).map(esc).join(' & ')} wins!` : `Round ${g.round} over`}</h2>
    <table><thead><tr><th>Player</th>${cols}</tr></thead><tbody>${rows.join('')}</tbody></table>
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
    case 'pile-step': {
      if (!(session instanceof HostSession) || !snapshot) return
      const next = snapshot.settings.pile + Number(el.dataset.step)
      return session.configure({ pile: Math.max(PILE_MIN, Math.min(PILE_MAX, next)) })
    }
    case 'help':
      helpOpen = !helpOpen
      return render()
    case 'help-close':
      helpOpen = false
      return render()
    case 'end-turn': return session!.send({ type: 'endTurn', playerId: session!.myId })
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
// The board fills the screen, so the view takes the window's shape.
const boardAspect = () => window.innerHeight / Math.max(1, window.innerWidth)
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
  // Fit the pattern plus room for targets and the seats drawn over the edges.
  const w = Math.max(9, Math.max(...xs) - Math.min(...xs) + 6, (Math.max(...ys) - Math.min(...ys) + 7) / boardAspect())
  return { x, y, w }
}

function camViewBox(g: GameState): string {
  if (!cam.ready) {
    Object.assign(cam, camTarget(g))
    cam.ready = true
  }
  const h = cam.w * boardAspect()
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
  if (!board || drag || pan || e.button !== 0 || (e.target as Element).closest('.hit[data-stick]')) return
  e.preventDefault() // no text selection or native drag while panning
  pan = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y }
  board.setPointerCapture(e.pointerId)
  board.classList.add('panning')
})
window.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.pointerId) return
  if (e.buttons === 0) return endPan(e) // released somewhere we never heard about
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
window.addEventListener('pointerup', endPan)
window.addEventListener('pointercancel', endPan)

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
  if (!hit || !g || !isMyTurn() || drag || e.button !== 0) return
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

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return
  if (e.buttons === 0) return endDrag(e, true)
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
  // Without move hints the stick never snaps into place, so it reveals nothing.
  const shown = d.snap !== null && snapshot!.game!.settings.hints ? d.targets[d.snap] : floating
  board.querySelector('.drag-layer')!.innerHTML = stickSvg(shown, `class="stick held ${d.snap !== null ? 'snapped' : ''}"`)
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

window.addEventListener('pointerup', (e) => endDrag(e, true))
window.addEventListener('pointercancel', (e) => endDrag(e, false))

// Dragging the pile slider updates the number live; the setting is sent on release.
app.addEventListener('input', (e) => {
  const range = e.target as HTMLInputElement
  if (!range.classList.contains('pile-range')) return
  const b = document.querySelector('#pile-value b')
  if (b) b.textContent = range.value
  range.style.setProperty('--fill', `${((Number(range.value) - PILE_MIN) / (PILE_MAX - PILE_MIN)) * 100}%`)
})

app.addEventListener('change', (e) => {
  if (!(session instanceof HostSession)) return
  const el = e.target as HTMLInputElement | HTMLSelectElement
  const key = el.dataset.setting as keyof Settings | undefined
  if (!key) return
  const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked
    : key === 'botSpeed' || key === 'mode' ? el.value : Number(el.value)
  session.configure({ [key]: value })
})

window.addEventListener('beforeunload', (e) => {
  if (session instanceof HostSession && snapshot?.game) e.preventDefault()
})

// Test hook: plays a move for the local player (matching if possible).
declare global {
  interface Window {
    __stigits?: {
      snapshot: () => Snapshot | null
      myId: () => string | null
      handOrder: () => number[]
      autoMove: () => boolean
      autoClaim: () => boolean
      matches: (card: number) => boolean
    }
  }
}
window.__stigits = {
  snapshot: () => snapshot,
  myId: () => session?.myId ?? null,
  matches: (card: number) => {
    const g = snapshot?.game
    return !!g && matchingCard([card], g.pattern) === 0
  },
  autoClaim: () => {
    const g = snapshot?.game
    const me = g?.players.find((p) => p.id === session?.myId)
    if (!g || !me || g.phase !== 'playing') return false
    const h = matchingCard(me.hand, g.pattern)
    if (h < 0) return false
    playCard(me.hand[h])
    return true
  },
  handOrder: () => hand.cardOrder,
  autoMove: () => {
    const g = snapshot?.game
    if (!g || !session || g.phase !== 'playing' || g.players[g.current].id !== session.myId) return false
    if (g.movesLeft < 1) {
      session.send({ type: 'endTurn', playerId: session.myId })
      return true
    }
    const moves = allMoves(g)
    const move = findMatchingMove(g) ?? moves[Math.floor(Math.random() * moves.length)]
    session.send({ type: 'move', playerId: session.myId, ...move })
    return true
  },
}

render()
