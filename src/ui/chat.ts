import { t } from '../i18n'
import { CHAT_MAX_LENGTH, type ChatMessage } from '../net/session'

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** How many incoming bubbles show at once, and for how long. */
const FLYOUT_MAX = 3
const FLYOUT_MS = 5000

const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>'

/**
 * The table chat: a button with an unread count, a panel with the messages and a
 * box to type in. Messages that arrive while it is closed fly up as bubbles above the button.
 * It lives outside the re-rendered page so a half-typed message is never lost.
 */
export class ChatView {
  readonly el: HTMLDivElement
  private list: HTMLDivElement
  private input: HTMLInputElement
  private badge: HTMLSpanElement
  private flyouts: HTMLDivElement
  private open = false
  private seen = 0
  private latest = 0
  private myId = ''
  private send: (text: string) => void
  private onIncoming: () => void

  constructor(send: (text: string) => void, onIncoming: () => void) {
    this.send = send
    this.onIncoming = onIncoming
    this.el = document.createElement('div')
    this.el.className = 'chat'
    this.el.hidden = true
    this.el.innerHTML = `
      <button class="help-btn chat-btn" type="button" aria-expanded="false">${ICON}<span class="chat-badge" hidden></span></button>
      <div class="chat-flyouts" aria-hidden="true"></div>
      <section class="chat-panel" hidden>
        <header><b></b><button class="help-close" type="button">×</button></header>
        <div class="chat-list" aria-live="polite"></div>
        <form class="chat-form"><input maxlength="${CHAT_MAX_LENGTH}" autocomplete="off"/><button class="primary" type="submit"></button></form>
      </section>`
    this.list = this.el.querySelector('.chat-list')!
    this.input = this.el.querySelector('input')!
    this.badge = this.el.querySelector('.chat-badge')!
    this.flyouts = this.el.querySelector('.chat-flyouts')!
    this.el.querySelector('.chat-btn')!.addEventListener('click', () => this.toggle(!this.open))
    this.el.querySelector('.help-close')!.addEventListener('click', () => this.toggle(false))
    this.flyouts.addEventListener('click', () => this.toggle(true))
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      const text = this.input.value.trim()
      if (text) this.send(text)
      this.input.value = ''
    })
    // Keys typed in the chat must not turn or flip a held card.
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') this.toggle(false)
    })
    document.body.append(this.el)
    this.relabel()
  }

  /** Re-apply the labels, e.g. after the language changes. */
  relabel(): void {
    const btn = this.el.querySelector('.chat-btn')!
    btn.setAttribute('aria-label', t.chat)
    btn.setAttribute('title', t.chat)
    this.el.querySelector('.chat-panel header b')!.textContent = t.chat
    this.el.querySelector('.help-close')!.setAttribute('aria-label', t.close)
    this.input.placeholder = t.chatPlaceholder
    this.el.querySelector('.chat-form button')!.textContent = t.send
    if (!this.latest) this.list.innerHTML = `<p class="chat-empty">${t.chatEmpty}</p>`
  }

  /** Show the chat for an online table (hidden offline), with the latest messages. */
  update(messages: ChatMessage[] | null, myId: string): void {
    this.el.hidden = messages === null
    if (!messages) {
      this.toggle(false)
      this.seen = this.latest = 0
      return
    }
    this.myId = myId
    const last = messages.at(-1)?.seq ?? 0
    if (last === this.latest) return
    const fresh = messages.filter((m) => m.seq > this.latest && m.from !== myId)
    this.latest = last
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40
    this.list.innerHTML = messages.length ? messages.map((m) => `<p class="chat-msg ${m.from === myId ? 'mine' : ''}">
      <b style="color: ${esc(m.color ?? 'var(--accent)')}">${esc(m.name)}</b> ${esc(m.text)}</p>`).join('')
      : `<p class="chat-empty">${t.chatEmpty}</p>`
    if (atBottom || this.open) this.list.scrollTop = this.list.scrollHeight
    if (this.open) this.seen = last
    else for (const m of fresh.slice(-FLYOUT_MAX)) this.flyout(m)
    if (fresh.length) this.onIncoming()
    this.paintBadge(messages)
  }

  /** A bubble that rises from the button, lingers, then fades; only the newest few stay. */
  private flyout(m: ChatMessage): void {
    const bubble = document.createElement('div')
    bubble.className = 'chat-flyout'
    bubble.style.setProperty('--who', m.color ?? 'var(--accent)')
    bubble.innerHTML = `<b>${esc(m.name)}</b> ${esc(m.text)}`
    this.flyouts.append(bubble)
    while (this.flyouts.children.length > FLYOUT_MAX) this.flyouts.firstElementChild!.remove()
    setTimeout(() => {
      bubble.classList.add('leaving')
      setTimeout(() => bubble.remove(), 400)
    }, FLYOUT_MS)
  }

  private paintBadge(messages?: ChatMessage[]): void {
    const unread = this.open ? 0 : (messages ?? []).filter((m) => m.seq > this.seen && m.from !== this.myId).length
    if (messages || this.open) {
      this.badge.hidden = unread === 0
      this.badge.textContent = unread > 9 ? '9+' : String(unread)
    }
  }

  private toggle(open: boolean): void {
    this.open = open
    this.el.querySelector<HTMLElement>('.chat-panel')!.hidden = !open
    this.el.querySelector('.chat-btn')!.setAttribute('aria-expanded', String(open))
    if (open) {
      this.seen = this.latest
      this.badge.hidden = true
      this.flyouts.replaceChildren()
      this.list.scrollTop = this.list.scrollHeight
      this.input.focus()
    }
  }
}
