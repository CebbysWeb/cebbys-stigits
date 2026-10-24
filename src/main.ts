import './style.css'
import { legalTargets } from './engine/geometry'
import { allMoves, findMatchingMove, winnerNames, type GameState } from './engine/game'
import { ClientSession, HostSession, type Session, type Snapshot } from './net/session'
import { boardSvg, cardSvg } from './ui/svg'

const app = document.querySelector<HTMLDivElement>('#app')!

let session: Session | null = null
let snapshot: Snapshot | null = null
let selected: number | null = null
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
    render()
  },
  onError: toast,
  onDisconnect() {
    status = 'Lost connection to the host. Reload the page to rejoin.'
    snapshot = null
    session = null
    render()
  },
}

async function connect(mode: 'host' | 'join', code?: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#name')
  const name = input?.value.trim() || 'Player'
  try {
    localStorage.setItem('stigits-name', name)
  } catch {
    /* storage unavailable */
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
  else app.innerHTML = renderGame(snapshot, snapshot.game)
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
  const players = s.players.map((p) => `<li>${esc(p.name)}${p.id === session!.myId ? ' (you)' : ''}${p.id === 'host' ? ' ★' : ''}</li>`)
  return `<main class="lobby">
    <h1>Stigits</h1>
    <section class="share">
      <p>Share this link with your friends:</p>
      <div class="row"><input readonly value="${esc(link)}" id="share"/><button data-act="copy">Copy</button></div>
      <p class="code">Code <b>${s.code}</b></p>
    </section>
    <section><h2>Players (${s.players.length}/4)</h2><ul class="players">${players.join('')}</ul></section>
    ${host ? `<section class="options">
      <label>Variant <select id="variant">
        <option value="standard" ${s.variant === 'standard' ? 'selected' : ''}>Standard</option>
        <option value="plus" ${s.variant === 'plus' ? 'selected' : ''}>Plus</option></select></label>
      <label>Rounds <select id="rounds">${[1, 2, 3, 5, 7].map((n) => `<option ${n === s.rounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="primary" data-act="start" ${s.players.length < 2 ? 'disabled' : ''}>Start game</button>
      ${s.players.length < 2 ? '<p class="hint">Waiting for at least one friend to join…</p>' : ''}
    </section>` : `<p class="status">Waiting for the host to start (${s.variant === 'plus' ? 'Plus' : 'Standard'}, ${s.rounds} rounds)…</p>`}
  </main>`
}

function renderGame(s: Snapshot, g: GameState): string {
  const me = g.players.findIndex((p) => p.id === session!.myId)
  const myTurn = g.phase === 'playing' && g.current === me
  const targets = myTurn && selected !== null ? legalTargets(g.pattern, selected) : []
  const turnText = g.phase !== 'playing' ? 'Round over'
    : myTurn ? (selected === null ? 'Your turn — tap a stick to pick it up' : 'Tap a highlighted spot to place it')
    : `${esc(g.players[g.current].name)} is moving…`
  const scoreLabel = g.variant === 'plus' ? 'pts' : 'minus'

  const opponents = g.players.map((p, i) => {
    const online = s.players.find((x) => x.id === p.id)?.connected !== false
    return `<div class="opponent ${i === g.current ? 'active' : ''} ${i === me ? 'me' : ''}">
      <div class="who">${esc(p.name)}${i === me ? ' (you)' : ''}${online ? '' : ' <span class="off">offline</span>'}</div>
      <div class="meta">${p.hand.length} cards · ${g.variant === 'plus' ? `${p.pile.length} played · ` : ''}${p.score} ${scoreLabel}</div>
      ${i === me ? '' : `<div class="mini">${p.hand.map(cardSvg).join('')}</div>`}
    </div>`
  })

  const hand = me >= 0 ? g.players[me].hand.map((c) => `<div class="card">${cardSvg(c)}</div>`).join('') : ''
  const lastPlays = g.lastPlayed.map((p) => `<div class="card played" title="${esc(g.players[p.player].name)}">${cardSvg(p.card)}<span>${esc(g.players[p.player].name)}</span></div>`).join('')

  return `<main class="game">
    <header>
      <span>Round ${g.round}/${g.roundsTotal} · ${g.variant === 'plus' ? 'Plus' : 'Standard'} · Deck ${g.deck.length}</span>
      <span class="code">Code ${s.code}</span>
    </header>
    <section class="players-bar">${opponents.join('')}</section>
    <section class="table">
      <p class="turn ${myTurn ? 'mine' : ''}">${turnText}</p>
      ${boardSvg({ pattern: g.pattern, selected: myTurn ? selected : null, targets, lastTo: g.lastMove?.to ?? null, interactive: myTurn })}
      ${myTurn && selected !== null ? '<button class="link" data-act="cancel">Put it back</button>' : ''}
      ${lastPlays ? `<div class="last"><span>Just matched:</span>${lastPlays}</div>` : ''}
    </section>
    <section class="hand"><h2>Your cards</h2><div class="cards">${hand || '<p class="hint">No cards left!</p>'}</div></section>
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
  const el = (e.target as Element).closest<HTMLElement>('[data-act],[data-stick],[data-target]')
  if (!el) return
  const g = snapshot?.game
  if (el.dataset.stick !== undefined && g) {
    const i = Number(el.dataset.stick)
    selected = selected === i ? null : i
    if (selected !== null && legalTargets(g.pattern, selected).length === 0) {
      toast('That stick holds the pattern together — pick another.')
      selected = null
    }
    render()
    return
  }
  if (el.dataset.target !== undefined && g && selected !== null) {
    const to = legalTargets(g.pattern, selected)[Number(el.dataset.target)]
    session!.send({ type: 'move', playerId: session!.myId, index: selected, to })
    return
  }
  switch (el.dataset.act) {
    case 'host': return connect('host')
    case 'join': return connect('join', el.dataset.code)
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
    case 'cancel':
      selected = null
      return render()
  }
})

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
    __stigits?: { snapshot: () => Snapshot | null; myId: () => string | null; autoMove: () => boolean }
  }
}
window.__stigits = {
  snapshot: () => snapshot,
  myId: () => session?.myId ?? null,
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
