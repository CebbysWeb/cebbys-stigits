import Peer, { type DataConnection } from 'peerjs'
import { allMoves, applyAction, findMatchingMove, matchingCard, newGame, type Action, type GameState, type Variant } from '../engine/game'

const PEER_PREFIX = 'cebbys-stigits-'
export const HOST_ID = 'host'
export const MAX_PLAYERS = 4
/** Code shown for an offline practice game, which has no peer to join. */
export const LOCAL_CODE = 'LOCAL'
const BOT_PREFIX = 'bot-'
const BOT_NAMES = ['Robo Rita', 'Bolt', 'Sir Sparks', 'Gizmo']
// Bots think a while before moving, leaving everyone time to spot the new shape.
const BOT_MOVE_MS = [2000, 3500]
// Bots spot a matching card after a human-ish pause, so people can beat them to it;
// a bot that just made its own shape knows it and calls it quickly.
const BOT_SPOT_MS = [1500, 3500]
const BOT_OWN_SHAPE_MS = [400, 900]
const between = ([min, max]: number[]) => min + Math.random() * (max - min)
export const isBot = (id: string): boolean => id.startsWith(BOT_PREFIX)

export interface LobbyPlayer {
  id: string
  name: string
  connected: boolean
}
export interface Snapshot {
  code: string
  players: LobbyPlayer[]
  variant: Variant
  rounds: number
  game: GameState | null
}

type ToHost = { t: 'hello'; pid: string; name: string } | { t: 'action'; action: Action }
type ToClient = { t: 'snapshot'; snapshot: Snapshot } | { t: 'error'; message: string }

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
  destroy(): void
}

export interface SessionEvents {
  onSnapshot(s: Snapshot): void
  onError(message: string): void
  onDisconnect?(): void
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

  private constructor(peer: Peer | null, code: string, name: string, events: SessionEvents) {
    this.peer = peer
    this.events = events
    this.snapshot = {
      code,
      players: [{ id: HOST_ID, name, connected: true }],
      variant: 'standard',
      rounds: 3,
      game: null,
    }
    peer?.on('connection', (conn) => this.accept(conn))
    peer?.on('disconnected', () => peer.reconnect())
  }

  /** An offline game against bots: no network needed. */
  static local(name: string, events: SessionEvents): HostSession {
    const session = new HostSession(null, LOCAL_CODE, name, events)
    session.addBot()
    return session
  }

  get isLocal(): boolean {
    return this.peer === null
  }

  addBot(): void {
    const s = this.snapshot
    if (s.game || s.players.length >= MAX_PLAYERS) return
    const used = new Set(s.players.map((p) => p.id))
    const n = BOT_NAMES.findIndex((_, i) => !used.has(BOT_PREFIX + i))
    s.players.push({ id: BOT_PREFIX + n, name: BOT_NAMES[n], connected: true })
    this.publish()
  }

  removePlayer(id: string): void {
    if (this.snapshot.game || !isBot(id)) return
    this.snapshot.players = this.snapshot.players.filter((p) => p.id !== id)
    this.publish()
  }

  // Bots take a matching move when they have one, otherwise a random legal move.
  private scheduleBot(): void {
    const g = this.snapshot.game
    if (this.botTimer || !g || g.phase !== 'playing' || !isBot(g.players[g.current].id)) return
    this.botTimer = window.setTimeout(() => {
      this.botTimer = 0
      const game = this.snapshot.game
      if (!game || game.phase !== 'playing') return
      const bot = game.players[game.current]
      if (!isBot(bot.id)) return
      const moves = allMoves(game)
      const move = findMatchingMove(game) ?? moves[Math.floor(Math.random() * moves.length)]
      this.handle({ type: 'move', playerId: bot.id, ...move })
    }, between(BOT_MOVE_MS))
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
      const delay = between(bot.id === mover ? BOT_OWN_SHAPE_MS : BOT_SPOT_MS)
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

  static async create(name: string, events: SessionEvents): Promise<HostSession> {
    for (let attempt = 0; ; attempt++) {
      const code = randomCode()
      try {
        const peer = await openPeer(PEER_PREFIX + code)
        return new HostSession(peer, code, name, events)
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id' || attempt > 3) throw err
      }
    }
  }

  private accept(conn: DataConnection): void {
    let pid: string | null = null
    conn.on('data', (raw) => {
      const msg = raw as ToHost
      if (msg.t === 'hello') {
        pid = this.join(conn, msg)
      } else if (msg.t === 'action' && pid) {
        this.handle({ ...msg.action, playerId: pid }, conn)
      }
    })
    conn.on('close', () => {
      if (!pid || this.conns.get(pid) !== conn) return
      this.conns.delete(pid)
      const p = this.snapshot.players.find((x) => x.id === pid)
      if (p) p.connected = false
      // Before the game starts a departed player simply leaves the lobby.
      if (!this.snapshot.game) this.snapshot.players = this.snapshot.players.filter((x) => x.id !== pid)
      this.publish()
    })
  }

  private join(conn: DataConnection, msg: { pid: string; name: string }): string | null {
    const existing = this.snapshot.players.find((p) => p.id === msg.pid)
    if (existing) {
      existing.connected = true
    } else if (this.snapshot.game) {
      return this.reject(conn, 'This game has already started.')
    } else if (this.snapshot.players.length >= MAX_PLAYERS) {
      return this.reject(conn, 'This game is full (4 players).')
    } else {
      const name = String(msg.name || 'Player').slice(0, 20)
      this.snapshot.players.push({ id: msg.pid, name, connected: true })
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

  configure(variant: Variant, rounds: number): void {
    this.snapshot.variant = variant
    this.snapshot.rounds = rounds
    this.publish()
  }

  start(): void {
    const s = this.snapshot
    s.players = s.players.filter((p) => p.connected)
    s.game = newGame(s.players, { variant: s.variant, rounds: s.rounds })
    this.publish()
  }

  backToLobby(): void {
    this.snapshot.game = null
    this.snapshot.players = this.snapshot.players.filter((p) => p.connected)
    this.publish()
  }

  private publish(): void {
    const msg: ToClient = { t: 'snapshot', snapshot: this.snapshot }
    for (const c of this.conns.values()) if (c.open) c.send(msg)
    this.events.onSnapshot(structuredClone(this.snapshot))
    this.scheduleBot()
    this.scheduleBotClaims()
  }

  destroy(): void {
    clearTimeout(this.botTimer)
    for (const t of this.botClaims.values()) clearTimeout(t)
    this.peer?.destroy()
  }
}

export class ClientSession implements Session {
  readonly isHost = false
  readonly myId: string
  private conn: DataConnection
  private peer: Peer

  private constructor(peer: Peer, conn: DataConnection, myId: string) {
    this.peer = peer
    this.conn = conn
    this.myId = myId
  }

  static async join(code: string, name: string, events: SessionEvents): Promise<ClientSession> {
    // A stable per-tab id lets a reloaded tab reclaim its seat.
    let pid = sessionStorage.getItem('stigits-pid')
    if (!pid) {
      pid = 'p-' + crypto.randomUUID()
      sessionStorage.setItem('stigits-pid', pid)
    }
    const peer = await openPeer()
    const conn = peer.connect(PEER_PREFIX + code.toUpperCase(), { reliable: true })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not reach the host. Check the code.')), 15000)
      conn.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      peer.once('error', (err) => {
        clearTimeout(timer)
        reject(err.type === 'peer-unavailable' ? new Error(`No game found with code ${code}.`) : err)
      })
    })
    conn.on('data', (raw) => {
      const msg = raw as ToClient
      if (msg.t === 'snapshot') events.onSnapshot(msg.snapshot)
      else events.onError(msg.message)
    })
    conn.on('close', () => events.onDisconnect?.())
    conn.send({ t: 'hello', pid, name } satisfies ToHost)
    return new ClientSession(peer, conn, pid)
  }

  send(action: Action): void {
    this.conn.send({ t: 'action', action: { ...action, playerId: this.myId } } satisfies ToHost)
  }

  destroy(): void {
    this.peer.destroy()
  }
}
