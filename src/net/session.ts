import Peer, { type DataConnection } from 'peerjs'
import { allMoves, applyAction, DEFAULT_SETTINGS, findMatchingMove, matchingCard, newGame, type Action, type GameState, type Settings } from '../engine/game'

const PEER_PREFIX = 'cebbys-stigits-'
export const HOST_ID = 'host'
export { MAX_PLAYERS } from '../engine/game'
import { MAX_PLAYERS } from '../engine/game'
/** Code shown for an offline practice game, which has no peer to join. */
export const LOCAL_CODE = 'LOCAL'
const BOT_PREFIX = 'bot-'
const BOT_NAMES = ['Robo Rita', 'Bolt', 'Sir Sparks', 'Gizmo', 'Widget', 'Cogsworth', 'Pixel', 'Dynamo', 'Ratchet', 'Sprocket', 'Volt']
// Bots think a while before moving, leaving everyone time to spot the new shape.
const BOT_MOVE_MS = [2000, 3500]
// Bots spot a matching card after a human-ish pause, so people can beat them to it;
// a bot that just made its own shape knows it and calls it quickly.
const BOT_SPOT_MS = [1500, 3500]
const BOT_OWN_SHAPE_MS = [400, 900]
// Out of moves, a bot waits a moment (others may still call the shape) and ends its turn.
const BOT_END_TURN_MS = [1200, 2000]
const between = ([min, max]: number[]) => min + Math.random() * (max - min)
const BOT_PACE = { relaxed: 2.6, normal: 1.7, quick: 1 }
export const isBot = (id: string): boolean => id.startsWith(BOT_PREFIX)

export interface LobbyPlayer {
  id: string
  name: string
  connected: boolean
  /** The player's chosen colour, used to tint their card backs. */
  color?: string
}
export interface ChatMessage {
  seq: number
  from: string
  name: string
  color?: string
  text: string
}
/** Chat keeps only the latest messages, and each one short. */
export const CHAT_KEEP = 50
export const CHAT_MAX_LENGTH = 200

export interface Snapshot {
  code: string
  chat?: ChatMessage[]
  players: LobbyPlayer[]
  settings: Settings
  game: GameState | null
  /** When the current turn runs out, on the host's clock, or null with no limit. */
  deadline?: number | null
  /** The host's clock when this snapshot was sent, so guests can turn `deadline` into time left. */
  sentAt?: number
}

type ToHost = { t: 'hello'; pid: string; name: string; color?: string } | { t: 'action'; action: Action } | { t: 'chat'; text: string } | { t: 'pong' }
type ToClient = { t: 'snapshot'; snapshot: Snapshot } | { t: 'error'; message: string } | { t: 'ping' }

/**
 * STUN finds a direct path for most players. A TURN relay covers networks that
 * block direct connections (mobile carriers, strict Wi-Fi). Set the VITE_TURN_*
 * variables at build time, e.g. with a free metered.ca or Cloudflare TURN account.
 */
export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ]
  const urls = import.meta.env.VITE_TURN_URLS as string | undefined
  if (urls) {
    servers.push({
      urls: urls.split(',').map((u) => u.trim()),
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    })
  }
  return servers
}

// `?relay=1` forces traffic through TURN, to check the relay works.
const forceRelay = new URLSearchParams(location.search).has('relay')
const peerOptions = () => ({
  config: { iceServers: iceServers(), iceTransportPolicy: forceRelay ? 'relay' : 'all' } as RTCConfiguration,
})

export function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions())
    peer.once('open', () => resolve(peer))
    peer.once('error', (err) => {
      peer.destroy()
      reject(err)
    })
  })
}

export interface Session {
  readonly myId: string
  readonly isHost: boolean
  send(action: Action): void
  /** Post a chat message to the table. */
  say(text: string): void
  /** Leave for good, so the game is not offered for resuming. */
  quit(): void
  destroy(): void
}

/** A guest's link to the host: connected, trying to get back, or given up. */
export type NetState = 'online' | 'reconnecting' | 'lost'

export interface SessionEvents {
  onSnapshot(s: Snapshot): void
  onError(message: string): void
  onNetState?(state: NetState): void
}

const HOST_SAVE_KEY = 'stigits-host'
const GUEST_SAVE_KEY = 'stigits-guest'
/** A saved game can be resumed or rejoined for this long. */
const RESUME_MS = 2 * 60 * 60 * 1000
/** An offline player's turn is ended for them after this long. */
const OFFLINE_SKIP_MS = 15_000
/** A dropped guest retries every RETRY_MS, giving up after RETRY_LIMIT tries. */
const RETRY_MS = 2000
/**
 * Heartbeat: the host pings every guest, and each side drops a link it has not heard
 * from for a while. Phones often lose a connection without either end being told.
 */
const PING_MS = 4000
const SILENT_MS = 15_000

/**
 * Calls `tick(frozen)` every `ms`. `frozen` is true when the page was suspended
 * (a backgrounded phone tab), so silence during that time is not held against a link.
 */
function heartbeat(ms: number, tick: (frozen: boolean) => void): () => void {
  let last = Date.now()
  const id = window.setInterval(() => {
    const now = Date.now()
    tick(now - last > ms * 2.5)
    last = now
  }, ms)
  return () => clearInterval(id)
}
const RETRY_LIMIT = 30

function readSaved<T extends { at: number }>(key: string): T | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
    return v && Date.now() - v.at < RESUME_MS ? v : null
  } catch {
    return null
  }
}
function writeSaved(key: string, value: object | null): void {
  try {
    if (value) localStorage.setItem(key, JSON.stringify({ ...value, at: Date.now() }))
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable: nothing to resume later */
  }
}

/** The online game this device was hosting, if recent enough to pick up again. */
export const savedHostGame = () => readSaved<{ snapshot: Snapshot; at: number }>(HOST_SAVE_KEY)
/** The online game this device last joined as a guest, if recent enough to rejoin. */
export const savedGuestGame = () => readSaved<{ code: string; pid: string; at: number }>(GUEST_SAVE_KEY)
export const forgetSavedGames = (): void => {
  writeSaved(HOST_SAVE_KEY, null)
  writeSaved(GUEST_SAVE_KEY, null)
}

/**
 * The host's browser is the game server: it owns the snapshot and validates every
 * action. Bots are played here too. Without a peer it runs an offline practice game.
 */
export class HostSession implements Session {
  readonly myId = HOST_ID
  readonly isHost = true
  snapshot: Snapshot
  private conns = new Map<string, DataConnection>()
  private peer: Peer | null
  private events: SessionEvents
  private botTimer = 0
  private botClaims = new Map<string, number>()
  private offlineTimer = 0
  private limitTimer = 0
  private limitTurn = ''
  private closed = false
  private heard = new Map<DataConnection, number>()
  private stopBeat: () => void = () => {}
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible' || this.closed) return
    if (this.peer?.disconnected) this.peer.reconnect()
    this.publish()
  }

  private constructor(peer: Peer | null, code: string, name: string, color: string, events: SessionEvents) {
    this.peer = peer
    this.events = events
    this.snapshot = {
      code,
      players: [{ id: HOST_ID, name, color, connected: true }],
      settings: { ...DEFAULT_SETTINGS },
      game: null,
    }
    peer?.on('connection', (conn) => this.accept(conn))
    peer?.on('disconnected', () => !this.closed && peer.reconnect())
    if (peer) {
      document.addEventListener('visibilitychange', this.onVisible)
      this.stopBeat = heartbeat(PING_MS, (frozen) => {
        const now = Date.now()
        for (const conn of this.conns.values()) {
          if (frozen) this.heard.set(conn, now)
          else if (now - (this.heard.get(conn) ?? now) > SILENT_MS) conn.close()
          else if (conn.open) conn.send({ t: 'ping' } satisfies ToClient)
        }
      })
    }
  }

  /** An offline game against bots: no network needed. */
  static local(name: string, color: string, events: SessionEvents): HostSession {
    const session = new HostSession(null, LOCAL_CODE, name, color, events)
    session.addBot()
    return session
  }

  get isLocal(): boolean {
    return this.peer === null
  }

  addBot(): void {
    const s = this.snapshot
    if (s.game || s.players.length >= MAX_PLAYERS) return
    s.settings.solo = false
    const used = new Set(s.players.map((p) => p.id))
    const n = BOT_NAMES.findIndex((_, i) => !used.has(BOT_PREFIX + i))
    s.players.push({ id: BOT_PREFIX + n, name: BOT_NAMES[n], color: `hsl(${Math.floor(Math.random() * 360)} 70% 48%)`, connected: true })
    this.publish()
  }

  removePlayer(id: string): void {
    if (this.snapshot.game || !isBot(id)) return
    this.snapshot.players = this.snapshot.players.filter((p) => p.id !== id)
    this.publish()
  }

  // On a bot's turn: move while it has moves (making its own shape when it can),
  // wait while it holds a match it is about to call, and otherwise end the turn.
  private scheduleBot(): void {
    const g = this.snapshot.game
    if (this.botTimer || !g || g.phase !== 'playing' || !isBot(g.players[g.current].id)) return
    const delay = g.movesLeft > 0 ? BOT_MOVE_MS : BOT_END_TURN_MS
    this.botTimer = window.setTimeout(() => {
      this.botTimer = 0
      const game = this.snapshot.game
      if (!game || game.phase !== 'playing') return
      const bot = game.players[game.current]
      if (!isBot(bot.id)) return
      if (game.movesLeft > 0) {
        const moves = allMoves(game)
        const move = findMatchingMove(game) ?? moves[Math.floor(Math.random() * moves.length)]
        this.handle({ type: 'move', playerId: bot.id, ...move })
      } else if (matchingCard(bot.hand, game.pattern) >= 0) {
        this.scheduleBot() // its claim is on the way and will earn another move
      } else {
        this.handle({ type: 'endTurn', playerId: bot.id })
      }
    }, between(delay) * BOT_PACE[g.settings.botSpeed])
  }

  // Any bot holding the shape on the grid calls it after a pause, if still valid then.
  private scheduleBotClaims(): void {
    const g = this.snapshot.game
    if (!g || g.phase !== 'playing') return
    const mover = g.lastMove ? g.players[(g.current - 1 + g.players.length) % g.players.length].id : null
    for (const bot of g.players) {
      if (!isBot(bot.id) || this.botClaims.has(bot.id)) continue
      const h = matchingCard(bot.hand, g.pattern)
      if (h < 0) continue
      const card = bot.hand[h]
      const seen = g.moveCount
      const delay = between(bot.id === mover ? BOT_OWN_SHAPE_MS : BOT_SPOT_MS) * BOT_PACE[g.settings.botSpeed]
      this.botClaims.set(bot.id, window.setTimeout(() => {
        this.botClaims.delete(bot.id)
        const now = this.snapshot.game
        if (now && now.phase === 'playing' && now.moveCount === seen) {
          const me = now.players.find((p) => p.id === bot.id)
          if (me?.hand.includes(card)) this.handle({ type: 'claim', playerId: bot.id, card, seen })
        }
        this.scheduleBotClaims()
      }, delay))
    }
  }

  /**
   * Pick a saved online game back up under its old code, so guests who are
   * retrying find the host again. Everyone counts as offline until they return.
   */
  static async resume(saved: Snapshot, events: SessionEvents): Promise<HostSession> {
    // The signalling server can take a few seconds to release the old id after a reload.
    for (let attempt = 0; ; attempt++) {
      try {
        const peer = await openPeer(PEER_PREFIX + saved.code)
        const host = saved.players.find((p) => p.id === HOST_ID)!
        const session = new HostSession(peer, saved.code, host.name, host.color ?? '', events)
        session.snapshot = structuredClone(saved)
        for (const p of session.snapshot.players) p.connected = p.id === HOST_ID || isBot(p.id)
        session.publish()
        return session
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id' || attempt > 8) throw err
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }

  static async create(name: string, color: string, events: SessionEvents): Promise<HostSession> {
    for (let attempt = 0; ; attempt++) {
      const code = randomCode()
      try {
        const peer = await openPeer(PEER_PREFIX + code)
        return new HostSession(peer, code, name, color, events)
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id' || attempt > 3) throw err
      }
    }
  }

  private accept(conn: DataConnection): void {
    let pid: string | null = null
    this.heard.set(conn, Date.now())
    conn.on('data', (raw) => {
      const msg = raw as ToHost
      this.heard.set(conn, Date.now())
      if (msg.t === 'hello') {
        pid = this.join(conn, msg)
      } else if (msg.t === 'chat' && pid) {
        this.chat(pid, msg.text)
      } else if (msg.t === 'action' && pid) {
        this.handle({ ...msg.action, playerId: pid }, conn)
      }
    })
    conn.on('close', () => {
      this.heard.delete(conn)
      if (!pid || this.conns.get(pid) !== conn) return
      this.conns.delete(pid)
      const p = this.snapshot.players.find((x) => x.id === pid)
      if (p) p.connected = false
      // Before the game starts a departed player simply leaves the lobby.
      if (!this.snapshot.game) this.snapshot.players = this.snapshot.players.filter((x) => x.id !== pid)
      this.publish()
    })
  }

  private join(conn: DataConnection, msg: { pid: string; name: string; color?: string }): string | null {
    const existing = this.snapshot.players.find((p) => p.id === msg.pid)
    if (existing) {
      existing.connected = true
    } else if (this.snapshot.game) {
      return this.reject(conn, 'This game has already started.')
    } else if (this.snapshot.players.length >= MAX_PLAYERS) {
      return this.reject(conn, `This game is full (${MAX_PLAYERS} players).`)
    } else {
      const name = String(msg.name || 'Player').slice(0, 20)
      const color = /^#[0-9a-f]{6}$/i.test(msg.color ?? '') ? msg.color : undefined
      this.snapshot.players.push({ id: msg.pid, name, color, connected: true })
    }
    this.conns.get(msg.pid)?.close()
    this.conns.set(msg.pid, conn)
    this.publish()
    return msg.pid
  }

  private reject(conn: DataConnection, message: string): null {
    conn.send({ t: 'error', message } satisfies ToClient)
    setTimeout(() => conn.close(), 500)
    return null
  }

  private handle(action: Action, conn?: DataConnection): void {
    const game = this.snapshot.game
    if (!game) return
    try {
      this.snapshot.game = applyAction(game, action)
      this.publish()
    } catch (err) {
      const message = (err as Error).message
      if (conn) conn.send({ t: 'error', message } satisfies ToClient)
      else this.events.onError(message)
    }
  }

  send(action: Action): void {
    this.handle({ ...action, playerId: HOST_ID })
  }

  say(text: string): void {
    this.chat(HOST_ID, text)
  }

  // The host stamps each message with the sender's name and colour, so nobody can post as someone else.
  private chat(from: string, raw: unknown): void {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH)
    const p = this.snapshot.players.find((x) => x.id === from)
    if (!text || !p) return
    const chat = this.snapshot.chat ?? []
    chat.push({ seq: (chat.at(-1)?.seq ?? 0) + 1, from, name: p.name, color: p.color, text })
    this.snapshot.chat = chat.slice(-CHAT_KEEP)
    this.publish()
  }

  configure(patch: Partial<Settings>): void {
    if (this.snapshot.game) return
    const s = this.snapshot
    // Practice is either singleplayer (just me) or against bots.
    if (patch.solo !== undefined && !this.isLocal) patch = { ...patch, solo: false }
    s.settings = { ...s.settings, ...patch }
    if (patch.solo) s.players = s.players.filter((p) => !isBot(p.id))
    else if (patch.solo === false && this.isLocal && !s.players.some((p) => isBot(p.id))) return this.addBot()
    this.publish()
  }

  start(): void {
    const s = this.snapshot
    s.players = s.players.filter((p) => p.connected)
    s.game = newGame(s.players, { ...s.settings, solo: this.isLocal && s.settings.solo })
    this.publish()
  }

  backToLobby(): void {
    this.snapshot.game = null
    this.snapshot.players = this.snapshot.players.filter((p) => p.connected)
    this.publish()
  }

  private publish(): void {
    if (this.closed) return
    this.snapshot.sentAt = Date.now()
    const msg: ToClient = { t: 'snapshot', snapshot: this.snapshot }
    for (const c of this.conns.values()) if (c.open) c.send(msg)
    this.events.onSnapshot(structuredClone(this.snapshot))
    this.scheduleBot()
    this.scheduleBotClaims()
    this.scheduleTurnLimit()
    this.scheduleOfflineSkip()
    if (this.peer) writeSaved(HOST_SAVE_KEY, { snapshot: this.snapshot })
  }

  // With a time limit, each turn gets a deadline when it starts; at the deadline the host ends it.
  private scheduleTurnLimit(): void {
    const g = this.snapshot.game
    const limit = g?.settings.turnLimit ?? 0
    const turn = g && g.phase === 'playing' && limit ? `${g.round}:${g.turn}:${g.current}` : ''
    if (turn === this.limitTurn) return
    this.limitTurn = turn
    clearTimeout(this.limitTimer)
    if (!turn) {
      if (this.snapshot.deadline) {
        this.snapshot.deadline = null
        this.publish()
      }
      return
    }
    const ms = limit * 1000
    this.snapshot.deadline = Date.now() + ms
    const who = g!.players[g!.current].id
    this.limitTimer = window.setTimeout(() => {
      if (this.limitTurn === turn) this.handle({ type: 'endTurn', playerId: who })
    }, ms)
    this.publish()
  }

  // Don't let the table wait forever on a player whose connection dropped.
  private scheduleOfflineSkip(): void {
    clearTimeout(this.offlineTimer)
    const g = this.snapshot.game
    if (!g || g.phase !== 'playing') return
    const who = g.players[g.current]
    if (isBot(who.id) || this.snapshot.players.find((p) => p.id === who.id)?.connected !== false) return
    const turn = `${g.round}:${g.turn}:${g.current}`
    this.offlineTimer = window.setTimeout(() => {
      const now = this.snapshot.game
      if (now && `${now.round}:${now.turn}:${now.current}` === turn) this.handle({ type: 'endTurn', playerId: who.id })
    }, OFFLINE_SKIP_MS)
  }

  /** Leave for good: the game is not offered for resuming. */
  quit(): void {
    if (this.peer) writeSaved(HOST_SAVE_KEY, null)
    this.destroy()
  }

  destroy(): void {
    this.closed = true
    clearTimeout(this.limitTimer)
    clearTimeout(this.offlineTimer)
    clearTimeout(this.botTimer)
    for (const t of this.botClaims.values()) clearTimeout(t)
    this.stopBeat()
    document.removeEventListener('visibilitychange', this.onVisible)
    this.peer?.destroy()
  }
}

export class ClientSession implements Session {
  readonly isHost = false
  readonly myId: string
  private conn: DataConnection | null = null
  private peer: Peer
  private retries = 0
  private retryTimer = 0
  private closed = false
  private readonly onOnline = () => this.state !== 'online' && this.retry()
  private heard = 0
  private stopBeat: () => void
  // Back from the background: rejoin at once rather than waiting out a retry timer.
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible' || this.closed) return
    if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect()
    if (!this.conn) this.retry()
    else if (Date.now() - this.heard > PING_MS * 2) this.drop()
  }
  state: NetState = 'online'

  private code: string
  private name: string
  private color: string
  private events: SessionEvents

  private constructor(peer: Peer, code: string, pid: string, name: string, color: string, events: SessionEvents) {
    this.peer = peer
    this.code = code
    this.myId = pid
    this.name = name
    this.color = color
    this.events = events
    peer.on('disconnected', () => !this.closed && peer.reconnect())
    window.addEventListener('online', this.onOnline)
    document.addEventListener('visibilitychange', this.onVisible)
    this.stopBeat = heartbeat(PING_MS, (frozen) => {
      if (frozen) this.heard = Date.now()
      else if (this.conn && Date.now() - this.heard > SILENT_MS) this.drop()
    })
  }

  /** Give up on a link that has gone quiet, and start reconnecting. */
  private drop(): void {
    const conn = this.conn
    this.conn = null
    conn?.close()
    if (this.state === 'online') this.dropped()
    else this.retry()
  }

  static async join(code: string, name: string, color: string, events: SessionEvents, pid?: string): Promise<ClientSession> {
    code = code.toUpperCase()
    // A stable id lets a reloaded tab, or a dropped connection, reclaim its seat.
    pid ??= sessionStorage.getItem('stigits-pid') ?? 'p-' + crypto.randomUUID()
    sessionStorage.setItem('stigits-pid', pid)
    const peer = await openPeer()
    const session = new ClientSession(peer, code, pid, name, color, events)
    try {
      await session.connect()
    } catch (err) {
      session.destroy()
      throw err
    }
    writeSaved(GUEST_SAVE_KEY, { code, pid })
    return session
  }

  private connect(): Promise<void> {
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true })
    return new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        clearTimeout(timer)
        this.peer.off('error', onError)
        conn.close()
        reject(err)
      }
      const onError = (err: { type?: string }) =>
        fail(err.type === 'peer-unavailable' ? new Error(`No game found with code ${this.code}.`) : (err as Error))
      const timer = setTimeout(() => fail(new Error('Could not reach the host. Check the code.')), 15000)
      this.peer.once('error', onError)
      conn.once('open', () => {
        clearTimeout(timer)
        this.peer.off('error', onError)
        this.conn = conn
        this.heard = Date.now()
        conn.on('data', (raw) => {
          const msg = raw as ToClient
          this.heard = Date.now()
          if (msg.t === 'ping') conn.send({ t: 'pong' } satisfies ToHost)
          else if (msg.t === 'snapshot') this.events.onSnapshot(msg.snapshot)
          else this.events.onError(msg.message)
        })
        conn.on('close', () => this.conn === conn && this.dropped())
        conn.send({ t: 'hello', pid: this.myId, name: this.name, color: this.color } satisfies ToHost)
        resolve()
      })
    })
  }

  private setState(state: NetState): void {
    this.state = state
    this.events.onNetState?.(state)
  }

  // The link to the host broke: keep trying quietly for a while, then give up and let the player choose.
  private dropped(): void {
    if (this.closed) return
    this.conn = null
    this.retries = 0
    this.setState('reconnecting')
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(async () => {
      if (this.closed || this.conn) return
      if (this.peer.destroyed) this.peer = await openPeer().catch(() => this.peer)
      else if (this.peer.disconnected) this.peer.reconnect()
      try {
        await this.connect()
        this.setState('online')
      } catch {
        if (++this.retries >= RETRY_LIMIT) this.setState('lost')
        else this.scheduleRetry()
      }
    }, RETRY_MS)
  }

  /** Try to get back to the host right away (after giving up, or when the network returns). */
  retry(): void {
    if (this.closed || this.conn) return
    this.retries = 0
    this.setState('reconnecting')
    clearTimeout(this.retryTimer)
    this.retryTimer = 0
    this.scheduleRetry()
  }

  say(text: string): void {
    if (this.conn?.open) this.conn.send({ t: 'chat', text } satisfies ToHost)
  }

  send(action: Action): void {
    if (this.conn?.open) this.conn.send({ t: 'action', action: { ...action, playerId: this.myId } } satisfies ToHost)
  }

  /** Leave for good: the game is not offered for rejoining. */
  quit(): void {
    writeSaved(GUEST_SAVE_KEY, null)
    this.destroy()
  }

  destroy(): void {
    this.closed = true
    clearTimeout(this.retryTimer)
    this.stopBeat()
    window.removeEventListener('online', this.onOnline)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.peer.destroy()
  }
}
