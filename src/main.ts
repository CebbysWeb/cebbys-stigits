import './style.css'
import { legalTargets } from './engine/geometry'
import { allMoves, findMatchingMove, matchingCard, PILE_MAX, PILE_MIN, PILE_STEP, winnerNames, type GameState, type Settings } from './engine/game'
import { guessLang, langPickerHtml, setLang, t, translateError, type Lang } from './i18n'
import { ClientSession, HostSession, isBot, type Session, type Snapshot, MAX_PLAYERS, LOCAL_CODE } from './net/session'
import { boardSvg, midpoint, stickSvg } from './ui/svg'
import { HandView } from './ui/hand'
import { PlayedPile } from './ui/pile'
import { bindColorPicker, colorPickerHtml, loadProfile, loadSettings, profileColor, saveProfile, saveSettings } from './ui/profile'
import type { Stick } from './engine/geometry'

const app = document.querySelector<HTMLDivElement>('#app')!

let session: Session | null = null
let snapshot: Snapshot | null = null
let selected: number | null = null
/** Whether the controls help panel is open; kept across re-renders. */
let helpOpen = false
const pile = new PlayedPile()
/** The face-down pile players refill from; it sits left of the shape, the played pile right of it. */
const drawPile = document.createElement('div')
drawPile.className = 'draw-pile'
const paintDrawPile = () => { drawPile.innerHTML = `<div class="draw-card"></div><div class="draw-card"></div><div class="draw-card"></div><span class="pile-count">${t.pickupPile}</span>` }
paintDrawPile()
const hand = new HandView({ interactive: true, minCard: 76, maxCard: 140, onPlay: playCard, dropTarget: () => pile.el })

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

/** This device's player profile (name and colour), remembered between visits. */
const profile = loadProfile()
setLang(profile.lang ?? guessLang())

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
      const { penalty, mode } = s.game.settings
      const miss = s.game.settings.miss
      const cost = mode === 'rounds' ? (penalty ? ` −${penalty}` : '')
        : miss === 'point' ? ' −1' : miss === 'toPile' ? t.costToPile : t.costDiscard
      toast(c.ok ? `${mine ? t.match : t.matched(who.name)} +1` : `${mine ? t.notMatch : t.missed(who.name)}${cost}`)
      if (mine && !c.ok) hand.flash(c.card, 'wrong')
      // Two players may hold the same shape, so look only in the claimer's hand.
      const fanOf = mine ? hand.el : document.querySelector(`.seat-fan[data-seat="${CSS.escape(who.id)}"]`)
      const el = c.ok ? fanOf?.querySelector<HTMLElement>(`.hand-card[data-card="${c.card}"]`) ?? null : null
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
  onError: (message: string) => toast(translateError(message)),
  onDisconnect() {
    status = t.lostHost
    snapshot = null
    session = null
    render()
  },
}

async function connect(mode: 'host' | 'join' | 'practice', code?: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#name')
  const name = input?.value.trim() || t.namePlaceholder
  profile.name = name
  saveProfile(profile)
  const color = profileColor(profile)
  if (mode === 'practice') {
    session = HostSession.local(name, color, events)
    // The host's table settings are remembered on this device.
    ;(session as HostSession).configure(loadSettings())
    events.onSnapshot(structuredClone((session as HostSession).snapshot))
    return
  }
  status = mode === 'host' ? t.opening : t.joining(code!)
  render()
  try {
    session = mode === 'host' ? await HostSession.create(name, color, events) : await ClientSession.join(code!, name, color, events)
    if (session instanceof HostSession) session.configure(loadSettings())
    status = ''
    if (session instanceof HostSession) events.onSnapshot(structuredClone(session.snapshot))
  } catch (err) {
    status = ''
    toast(translateError((err as Error).message || String(err)))
    render()
  }
}

function render(): void {
  if (!session || !snapshot) {
    app.innerHTML = renderHome()
    const home = app.querySelector<HTMLElement>('.home')
    if (home) bindColorPicker(home, profile, saveProfile)
  }
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
    app.querySelector('#draw-slot')?.replaceWith(drawPile)
    drawPile.classList.toggle('empty', g.pileLeft === 0)
    // The first frame was framed before the play area existed; reframe now that it is laid out.
    if (camFresh) {
      camFresh = false
      Object.assign(cam, camTarget(g))
      app.querySelector('.board')?.setAttribute('viewBox', camViewBox(g))
    }
    placePiles()
    pile.update(g.played.map((p) => p.card))
    for (const p of g.players) {
      const holder = app.querySelector<HTMLElement>(`.seat-fan[data-seat="${CSS.escape(p.id)}"]`)
      if (!holder) continue
      let view = seatHands.get(p.id)
      if (!view) seatHands.set(p.id, (view = new HandView({ interactive: false, minCard: 30, maxCard: 46, faceDown: true })))
      // Side seats are rotated, so their fan runs along the seat's height.
      const side = holder.closest('.seat-left, .seat-right')
      holder.style.setProperty('--back', p.color ?? '')
      if (side) holder.style.width = `${Math.min(320, (side as HTMLElement).clientHeight - 8)}px`
      holder.append(view.el)
      view.update(p.hand)
    }
  }
}

function renderHome(): string {
  const code = joinCodeFromUrl()
  const actions = status ? `<p class="status">${esc(status)}</p>` : code
    ? `<button class="primary big" data-act="join" data-code="${code}">${t.joinGame(code)}</button>
       <button class="link" data-act="clear-join">${t.hostInstead}</button>`
    : `<div class="menu">
        <button class="menu-card primary-card" data-act="host"><span class="menu-icon"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></span><b>${t.hostGame}</b><small>${t.hostAbout}</small></button>
        <button class="menu-card" data-act="practice"><span class="menu-icon"><svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M9 17h6"/></svg></span><b>${t.practice}</b><small>${t.practiceAbout}</small></button>
      </div>
      <div class="join-card">
        <span><b>${t.joinTitle}</b><small>${t.joinAbout}</small></span>
        <div class="row"><input id="code" maxlength="5" placeholder="${t.codePlaceholder}" aria-label="${t.code}"/><button data-act="join-code">${t.join}</button></div>
      </div>`
  return `<main class="home">
    <header class="hero">
      <h1>Stigits</h1>
      <p class="tagline">${t.tagline}</p>
    </header>
    <section class="profile">
      <div class="profile-head"><h2>${t.profile}</h2>${langPickerHtml()}</div>
      <label>${t.yourName} <input id="name" maxlength="20" value="${esc(profile.name)}" placeholder="${t.namePlaceholder}"/></label>
      ${colorPickerHtml(profile, t.yourColour)}
    </section>
    ${actions}
    <details class="rules"><summary>${t.howToPlay}</summary>
      <p>${t.rule1}</p><p>${t.rule2}</p><p>${t.rule3}</p><p>${t.rule4}</p>
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
      <span class="avatar" style="background: ${esc(p.color ?? 'var(--accent)')}">${esc(p.name.slice(0, 1).toUpperCase() || '?')}</span>
      <span class="pl-name">${esc(p.name)}${p.id === session!.myId ? ` <em>(${t.you})</em>` : ''}${isBot(p.id) ? ` <em>· ${t.bot}</em>` : ''}</span>
      ${p.id === 'host' ? `<span class="tag">${t.host}</span>` : ''}
      ${host && isBot(p.id) ? `<button class="icon" data-act="remove" data-id="${esc(p.id)}" aria-label="${esc(t.remove(p.name))}">×</button>` : ''}
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
    ['emptyDeck', t.modeEmptyDeck, t.modeEmptyDeckAbout],
    ['rounds', t.modeRounds, t.modeRoundsAbout],
  ]
  const missRules: [Settings['miss'], string, string][] = [
    ['toPile', t.missToPile, t.missToPileAbout],
    ['discard', t.missDiscard, t.missDiscardAbout],
    ['point', t.missPoint, t.missPointAbout],
  ]
  const missPicker = `<div class="setting setting-wide"><span><b>${t.wrongGuess}</b><small>${t.wrongGuessAbout}</small></span>
      <div class="segmented" role="radiogroup" aria-label="${t.wrongGuess}">${missRules.map(([v, label]) => `
        <label class="${set.miss === v ? 'on' : ''}"><input type="radio" name="miss" value="${v}" data-setting="miss" ${set.miss === v ? 'checked' : ''} ${lock}/>${label}</label>`).join('')}
      </div>
      <p class="seg-about">${missRules.find(([v]) => v === set.miss)![2]}</p>
    </div>`
  const pile = `<div class="pile-picker">
      <div class="stepper">
        <button type="button" data-act="pile-step" data-step="-${PILE_STEP}" aria-label="${t.fewerCards(PILE_STEP)}" ${!host || set.pile <= PILE_MIN ? 'disabled' : ''}>−</button>
        <output id="pile-value"><b>${set.pile}</b><span>${t.cards}</span></output>
        <button type="button" data-act="pile-step" data-step="${PILE_STEP}" aria-label="${t.moreCards(PILE_STEP)}" ${!host || set.pile >= PILE_MAX ? 'disabled' : ''}>+</button>
      </div>
      <input type="range" class="pile-range" min="${PILE_MIN}" max="${PILE_MAX}" step="${PILE_STEP}" value="${set.pile}"
        data-setting="pile" aria-label="${t.cardsInPile}" style="--fill: ${((set.pile - PILE_MIN) / (PILE_MAX - PILE_MIN)) * 100}%" ${lock}/>
      <div class="pile-scale"><span>${PILE_MIN}</span><span>${PILE_MAX}</span></div>
    </div>`
  const settings = `
    <div class="modes" role="radiogroup" aria-label="${t.modeEmptyDeck} / ${t.modeRounds}">${modes.map(([m, label, about]) => `
      <label class="mode ${set.mode === m ? 'on' : ''}">
        <input type="radio" name="mode" value="${m}" data-setting="mode" ${set.mode === m ? 'checked' : ''} ${lock}/>
        <b>${label}</b><small>${about}</small>
      </label>`).join('')}</div>
    ${rounds ? row(t.rounds, t.roundsAbout, select('rounds', [1, 2, 3, 5, 7, 10].map((r) => [r, String(r)])))
      : `<div class="setting setting-wide"><span><b>${t.drawPile}</b><small>${t.drawPileAbout}</small></span>${pile}</div>`}
    ${row(t.turnCards, t.turnCardsAbout, toggle('rotate'))}
    ${row(t.flipCards, t.flipCardsAbout, toggle('mirror'))}
    ${rounds ? row(t.wrongGuess, t.wrongGuessPoints, select('penalty', [[0, t.nothing], [1, t.points(1)], [2, t.points(2)]]))
      : missPicker}
    ${row(t.moveHints, t.moveHintsAbout, toggle('hints'))}
    ${row(t.botSpeed, t.botSpeedAbout, select('botSpeed', [['relaxed', t.relaxed], ['normal', t.normal], ['quick', t.quick]]))}`

  return `<main class="lobby">
    <header class="lobby-head">
      <h1>Stigits</h1>
      ${langPickerHtml()}
      ${local ? `<p class="status">${t.offlinePractice}</p>` : `<div class="share">
        <input readonly value="${esc(shareLink(s.code))}" id="share" aria-label="${t.inviteLink}"/>
        <button data-act="copy">${t.copyLink}</button>
        <span class="code">${t.code} <b>${s.code}</b></span>
      </div>`}
    </header>
    <div class="lobby-grid">
      <section class="panel">
        <div class="panel-head">
          <h2>${t.players} <span class="count">${n}/${MAX_PLAYERS}</span></h2>
          ${host ? `<button data-act="add-bot" ${full ? 'disabled' : ''}>${t.addBot}</button>` : ''}
        </div>
        <ul class="players">${players}</ul>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>${t.settings}</h2>${host ? '' : `<span class="tag">${t.setByHost}</span>`}</div>
        <div class="settings">${settings}</div>
      </section>
    </div>
    <footer class="lobby-foot">
      <p class="hint">${host ? (n < 2 ? t.waitingFriend : t.ready) : t.waitingHost}</p>
      ${host ? `<button class="primary start" data-act="start" ${n < 2 ? 'disabled' : ''}>${t.start}</button>` : ''}
    </footer>
  </main>`
}

function renderGame(s: Snapshot, g: GameState): string {
  const me = g.players.findIndex((p) => p.id === session!.myId)
  const myTurn = g.phase === 'playing' && g.current === me
  const targets = myTurn && selected !== null ? legalTargets(g.pattern, selected) : []
  const turnText = g.phase !== 'playing' ? t.roundOver
    : myTurn ? (g.movesLeft < 1 ? t.playToMove : selected !== null ? t.dropOnSpot : g.turnMoved ? t.matchMoveAgain : t.yourTurn)
    : t.isMoving(esc(g.players[g.current].name))

  // Seats follow turn order clockwise from me: the next player sits on my left.
  const seat = (i: number) => {
    const p = g.players[i]
    const online = s.players.find((x) => x.id === p.id)?.connected !== false
    const pos = i === me ? 'bottom' : seatSides(g.players.length - 1)[(i - me + g.players.length) % g.players.length - 1]
    return `<div class="seat seat-${pos} ${i === g.current ? 'active' : ''} ${i === me ? 'me' : ''}">
      <div class="seat-label" style="--who: ${esc(p.color ?? 'var(--accent)')}">
        <b>${esc(p.name)}${i === me ? ` (${t.you})` : ''}</b>${online ? '' : `<span class="off">${t.offline}</span>`}
        <span class="pts">${t.points(p.score)}</span>
        ${i === g.current ? `<span class="turn-badge">${t.turn(g.turn)}</span>` : ''}
      </div>
      ${i === me && myTurn ? `<button class="primary end-turn ${g.turnMoved ? 'blink' : ''}" data-act="end-turn">${t.endTurn}</button>` : ''}
      ${i === me
        ? (p.hand.length ? '<div id="hand-slot"></div>' : `<p class="hint">${t.noCards}</p>`)
        : `<div class="seat-fan" data-seat="${esc(p.id)}"></div>`}
    </div>`
  }


  return `<main class="game">
    <section class="table-layout">
      ${['left', 'top', 'right'].map((side) => {
        const n = g.players.length
        const mine = Array.from({ length: n - 1 }, (_, k) => (me + 1 + k) % n)
          .filter((_, k) => seatSides(n - 1)[k] === side)
        return mine.length ? `<div class="side side-${side}">${mine.map(seat).join('')}</div>` : ''
      }).join('')}
      <div class="play-area"></div>
      <div class="table">
        <p class="turn ${myTurn ? 'mine' : ''}">${turnText}${g.settings.mode === 'rounds' ? ` <span class="round-chip">${t.roundOf(g.round, g.roundsTotal)}</span>` : ''}</p>
        ${boardSvg({ pattern: g.pattern, selected: myTurn ? selected : null, targets, lastTo: g.lastMove?.to ?? null, interactive: myTurn, hints: g.settings.hints }, camViewBox(g))}
      </div>
      ${seat(me)}
      <div id="pile-slot"></div>
      <div id="draw-slot"></div>
    </section>
    <button class="help-btn" data-act="help" aria-label="${t.controls}">?</button>
    <button class="help-btn quit-btn" data-act="quit" aria-label="${t.quit}" title="${t.quit}">×</button>
    ${helpOpen ? `<div class="help-panel" role="dialog" aria-label="${t.controls}">
      <button class="help-close" data-act="help-close" aria-label="${t.close}">×</button>
      <h2>${t.controls}</h2>
      <ul>
        <li>${t.helpMove}</li>
        <li>${t.helpPlay(g.settings.penalty ? `−${g.settings.penalty}` : t.noPenalty)}</li>
        <li>${g.settings.rotate ? t.helpTurn : t.helpTurnOff}</li>
        <li>${g.settings.mirror ? t.helpMirror : t.helpMirrorOff}</li>
        <li>${t.helpPan}</li>
        <li>${t.helpReorder}</li>
      </ul>
    </div>` : ''}
    ${g.phase === 'playing' ? '' : renderRoundOver(g)}
  </main>`
}

function renderRoundOver(g: GameState): string {
  const host = session instanceof HostSession
  const over = g.phase === 'gameOver'
  const rows = [...g.players].sort((a, b) => b.score - a.score)
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${p.pile.length}</td><td>${p.score}</td></tr>`)
  const cols = `<th>${t.played}</th><th>${g.settings.mode === 'rounds' ? t.score : t.counted}</th>`
  return `<div class="overlay"><div class="dialog">
    <h2>${over ? t.wins(winnerNames(g).map(esc).join(' & ')) : t.roundNOver(g.round)}</h2>
    <table><thead><tr><th>${t.player}</th>${cols}</tr></thead><tbody>${rows.join('')}</tbody></table>
    ${host ? (over ? `<button class="primary" data-act="lobby">${t.backToLobby}</button>` : `<button class="primary" data-act="next">${t.nextRound}</button>`)
      : `<p class="hint">${t.waitingHostShort}</p>`}
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
      session.configure({ pile: Math.max(PILE_MIN, Math.min(PILE_MAX, next)) })
      return saveSettings(session.snapshot.settings)
    }
    case 'lang':
      profile.lang = el.dataset.lang as Lang
      saveProfile(profile)
      setLang(profile.lang)
      paintDrawPile()
      pile.update(snapshot?.game?.played.map((p) => p.card) ?? [])
      return render()
    case 'help':
      helpOpen = !helpOpen
      return render()
    case 'help-close':
      helpOpen = false
      return render()
    case 'quit':
      if (!confirm(session instanceof HostSession && session.snapshot.code !== LOCAL_CODE ? t.quitConfirmAll : t.quitConfirm)) return
      session?.destroy()
      session = null
      snapshot = null
      status = ''
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
        toast(t.linkCopied)
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
let camFresh = false
const cam = { x: 0, y: 0, w: 8, ready: false, idleSince: 0 }
let pan: { pointerId: number; startX: number; startY: number; camX: number; camY: number } | null = null

/** Centre and size, in lattice units, of the sticks' bounding box. */
function shapeBox(g: GameState): { x: number; y: number; w: number; h: number } {
  const pts = g.pattern.flatMap((s) => (s.d === 'H' ? [[s.x, s.y], [s.x + 1, s.y]] : [[s.x, s.y], [s.x, s.y + 1]]))
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => -p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

/**
 * Frame the shape and the piles beside it so the whole group sits in the open
 * space between the seats, as large as fits.
 */
function camTarget(g: GameState): { x: number; y: number; w: number } {
  const box = shapeBox(g)
  const vw = window.innerWidth
  const vh = window.innerHeight
  const area = app.querySelector('.play-area')?.getBoundingClientRect()
  const ax = area && area.width > 0 ? area : { left: 0, top: 0, width: vw, height: vh }
  // Pixels per lattice unit that fit the group: piles beyond ±PILE_REACH, shape plus a square above and below.
  const scale = Math.max(8, Math.min(vw / 9,
    (ax.width - 16) / (2 * (PILE_REACH + PILE_SQUARES)),
    (ax.height - 16) / Math.max(box.h + 2, PILE_SQUARES + 0.5)))
  // Shift the view so the shape centre lands on the play area's centre.
  const dx = ax.left + ax.width / 2 - vw / 2
  const dy = ax.top + ax.height / 2 - vh / 2
  return { x: box.x - dx / scale, y: box.y - dy / scale, w: vw / scale }
}

function camViewBox(g: GameState): string {
  if (!cam.ready) {
    Object.assign(cam, camTarget(g))
    cam.ready = true
    camFresh = true
  }
  const h = cam.w * boardAspect()
  return `${cam.x - cam.w / 2} ${cam.y - h / 2} ${cam.w} ${h}`
}

let lastFrame = performance.now()
/** Idle hint: on my turn, if no stick is touched for 10 s, the sticks wobble, then again every 5 s. */
const NUDGE_AFTER_MS = 10_000
const NUDGE_EVERY_MS = 5_000
let stickTouchedAt = performance.now()
let nudgedAt = 0
let nudgeTurn = ''

function nudgeSticks(now: number, g: GameState, board: SVGSVGElement): void {
  // A new turn (or round) restarts the idle clock.
  const turnKey = `${g.round}:${g.turn}:${g.current}`
  if (turnKey !== nudgeTurn) {
    nudgeTurn = turnKey
    stickTouchedAt = now
  }
  if (!isMyTurn() || g.movesLeft < 1 || drag) return
  const idle = now - stickTouchedAt
  if (idle < NUDGE_AFTER_MS || now - nudgedAt < NUDGE_EVERY_MS) return
  nudgedAt = now
  // Just two sticks that can actually move, picked at random each time.
  const movable = [...board.querySelectorAll<SVGGElement>('.stick.pickable')]
    .filter((el) => legalTargets(g.pattern, Number(el.dataset.stick)).length)
  for (let i = 0; i < 2 && movable.length; i++) {
    const el = movable.splice(Math.floor(Math.random() * movable.length), 1)[0]
    el.classList.add('nudging')
    setTimeout(() => el.classList.remove('nudging'), 2300)
  }
}

/** Gap (px) between the shape and each pile. */
/** Piles sit as far out as a straight line of 5 sticks would reach, plus 1 square of padding. */
const PILE_REACH = 2.5 + 1
/** Each pile is this many squares wide, so it scales with the grid. */
const PILE_SQUARES = 2

/**
 * Keeps the pickup pile left of the shape and the played pile right of it, both
 * centred on its height. They follow the camera, gliding when the shape changes.
 */
/** The piles are pinned to the grid either side of the shape centre, so they move only with it (or the camera). */
function placePiles(): void {
  const g = snapshot?.game
  const ctm = app.querySelector<SVGSVGElement>('.board')?.getScreenCTM()
  if (!g || !ctm || !pile.el.isConnected) return
  const box = shapeBox(g)
  const c = new DOMPoint(box.x, box.y).matrixTransform(ctm)
  const unit = Math.hypot(ctm.a, ctm.b)
  const reach = PILE_REACH * unit
  const size = PILE_SQUARES * unit
  for (const el of [pile.el, drawPile]) {
    el.style.width = el.style.height = `${size}px`
    el.classList.toggle('compact', size < 110)
  }
  const top = `${c.y - size / 2}px`
  pile.el.style.left = `${c.x + reach}px`
  pile.el.style.top = top
  drawPile.style.left = `${c.x - reach - size}px`
  drawPile.style.top = top
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  const g = snapshot?.game
  const board = app.querySelector<SVGSVGElement>('.board')
  if (g && board) nudgeSticks(now, g, board)
  if (g && board && !pan && !drag && now - cam.idleSince > RECENTER_DELAY_MS) {
    const t = camTarget(g)
    const k = 1 - Math.exp(-dt / (RECENTER_SECONDS / 3))
    cam.x += (t.x - cam.x) * k
    cam.y += (t.y - cam.y) * k
    cam.w += (t.w - cam.w) * k
    board.setAttribute('viewBox', camViewBox(g))
  }
  if (!g) cam.ready = false
  placePiles()
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
    toast(t.stickHolds)
    return
  }
  e.preventDefault()
  stickTouchedAt = performance.now()
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
  if ((e.target as Element).id === 'name') {
    profile.name = (e.target as HTMLInputElement).value.trim()
    saveProfile(profile)
    return
  }
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
    : key === 'botSpeed' || key === 'mode' || key === 'miss' ? el.value : Number(el.value)
  session.configure({ [key]: value })
  saveSettings(session.snapshot.settings)
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
