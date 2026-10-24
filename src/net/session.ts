import Peer, { type DataConnection } from 'peerjs'
import { applyAction, newGame, type Action, type GameState, type Variant } from '../engine/game'

const PEER_PREFIX = 'cebbys-stigits-'
export const HOST_ID = 'host'
export const MAX_PLAYERS = 4

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

/** The host's browser is the game server: it owns the snapshot and validates every action. */
export class HostSession implements Session {
  readonly myId = HOST_ID
  readonly isHost = true
  snapshot: Snapshot
  private conns = new Map<string, DataConnection>()
  private peer: Peer
  private events: SessionEvents

  private constructor(peer: Peer, code: string, name: string, events: SessionEvents) {
    this.peer = peer
    this.events = events
    this.snapshot = {
      code,
      players: [{ id: HOST_ID, name, connected: true }],
      variant: 'standard',
      rounds: 3,
      game: null,
    }
    peer.on('connection', (conn) => this.accept(conn))
    peer.on('disconnected', () => peer.reconnect())
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
  }

  destroy(): void {
    this.peer.destroy()
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
