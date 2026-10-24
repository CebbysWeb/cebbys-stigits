import { expect, test, type Page } from '@playwright/test'

const center = async (p: Page, selector: string) => {
  const r = await p.locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  return r
}

/** Press on a movable stick, drag it to the first highlighted spot and release. */
async function dragStick(p: Page): Promise<void> {
  await p.locator('.hit[data-stick]').first().waitFor({ state: 'attached' })
  const count = await p.locator('.hit[data-stick]').count()
  for (let i = 0; i < count; i++) {
    const from = await center(p, `.hit[data-stick="${i}"]`)
    await p.mouse.move(from.x, from.y)
    await p.mouse.down()
    if (await p.locator('.ghost').count()) {
      const to = await center(p, '.ghost[data-ghost="0"]')
      await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
      await p.mouse.move(to.x, to.y, { steps: 4 })
      await expect(p.locator('.ghost.hot')).toHaveCount(1)
      await p.mouse.up()
      return
    }
    await p.mouse.up()
  }
  throw new Error('No movable stick')
}

// Two isolated browser contexts play a whole game over PeerJS/WebRTC.
// Needs internet access for the public PeerJS signaling server.
const BASE = process.env.E2E_URL ?? 'http://localhost:4173/'

for (const variant of ['standard', 'plus'] as const) {
  test(`full ${variant} game between two windows`, async ({ browser }) => {
    test.setTimeout(180_000)
    const host = await (await browser.newContext()).newPage()
    const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage()

    await host.goto(BASE)
    await host.fill('#name', 'Hosty')
    await host.click('[data-act=host]')
    const link = await host.locator('#share').inputValue()
    expect(link).toMatch(/#join=[A-Z0-9]{5}$/)

    await guest.goto(link)
    await guest.fill('#name', 'Guesty')
    await guest.click('[data-act=join]')
    await expect(host.locator('.players li')).toHaveCount(2)
    await expect(guest.locator('.status')).toContainText('Waiting for the host')

    await host.selectOption('#variant', variant)
    await host.selectOption('#rounds', '2')
    await host.click('[data-act=start]')
    await expect(guest.locator('.board')).toBeVisible()

    // First move through the real UI: drag a stick onto a green spot.
    await dragStick(host)
    await expect.poll(() => guest.evaluate(() => window.__stigits!.snapshot()!.game!.lastMove !== null)).toBe(true)
    // Rearrange the hand: drag the first card past the last one.
    const cardsBefore = await host.evaluate(() => window.__stigits!.handOrder())
    await host.locator('.seat.me .fan').scrollIntoViewIfNeeded()
    // Cards overlap in the fan, so grab the first card by its visible left edge.
    const firstBox = (await host.locator(`.hand-card[data-card="${cardsBefore[0]}"]`).boundingBox())!
    const first = { x: firstBox.x + firstBox.width * 0.2, y: firstBox.y + firstBox.height / 2 }
    const last = await center(host, `.hand-card[data-card="${cardsBefore[cardsBefore.length - 1]}"]`)
    await host.mouse.move(first.x, first.y)
    await host.mouse.down()
    await host.mouse.move(last.x + 40, last.y, { steps: 8 })
    await host.screenshot({ path: `e2e/results/${variant}-host-dragging-card.png` })
    await host.mouse.up()
    const order = await host.evaluate(() => window.__stigits!.handOrder())
    expect(order[order.length - 1]).toBe(cardsBefore[0])

    // Pan the board from an empty corner; the camera then drifts back to centre.
    await host.locator('.board').scrollIntoViewIfNeeded()
    // Distance of the view centre from the sticks' centre of mass, in board units.
    const offCentre = () => host.evaluate(() => {
      const [x, y, w, h] = document.querySelector('.board')!.getAttribute('viewBox')!.split(' ').map(Number)
      const mids = window.__stigits!.snapshot()!.game!.pattern.map((s) => (s.d === 'H' ? [s.x + 0.5, -s.y] : [s.x, -s.y - 0.5]))
      const cx = mids.reduce((a, m) => a + m[0], 0) / mids.length
      const cy = mids.reduce((a, m) => a + m[1], 0) / mids.length
      return Math.hypot(x + w / 2 - cx, y + h / 2 - cy)
    })
    const box = (await host.locator('.board').boundingBox())!
    await host.mouse.move(box.x + 12, box.y + 12)
    await host.mouse.down()
    await host.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 6 })
    const panned = await offCentre()
    expect(panned).toBeGreaterThan(0.5)
    await host.screenshot({ path: `e2e/results/${variant}-host-panned.png` })
    await host.mouse.up()
    await expect.poll(offCentre, { timeout: 8000 }).toBeLessThan(0.1)

    // The guest moves next, by dragging too.
    if (await guest.evaluate(() => { const g = window.__stigits!.snapshot()!.game!; return g.phase === 'playing' && g.players[g.current].id === window.__stigits!.myId() })) {
      const lastMove = () => host.evaluate(() => JSON.stringify(window.__stigits!.snapshot()!.game!.lastMove))
      const before = await lastMove()
      await dragStick(guest)
      await expect.poll(lastMove).not.toBe(before)
    }
    await host.screenshot({ path: `e2e/results/${variant}-host-midgame.png` })
    await guest.screenshot({ path: `e2e/results/${variant}-guest-mobile.png`, fullPage: true })

    // Then let both windows auto-play until the game is scored.
    const phase = (p: Page) => p.evaluate(() => window.__stigits!.snapshot()?.game?.phase)
    for (let i = 0; i < 4000 && (await phase(host)) !== 'gameOver'; i++) {
      if ((await phase(host)) === 'roundOver') {
        await host.click('[data-act=next]')
        continue
      }
      const moved = (await host.evaluate(() => window.__stigits!.autoMove())) ||
        (await guest.evaluate(() => window.__stigits!.autoMove()))
      if (moved) await host.waitForTimeout(15)
      else await host.waitForTimeout(50)
    }

    await expect(guest.locator('.dialog h2')).toContainText('wins')
    await expect(host.locator('.dialog h2')).toContainText('wins')
    const [h, g] = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__stigits!.snapshot()!.game)))
    expect(g).toEqual(h)
    expect(h!.round).toBe(2)
    await host.screenshot({ path: `e2e/results/${variant}-final.png` })
  })
}

test('four players join and finish a game', async ({ browser }) => {
  test.setTimeout(180_000)
  const pages: Page[] = []
  for (let i = 0; i < 4; i++) pages.push(await (await browser.newContext()).newPage())
  const [host, ...guests] = pages
  await host.goto(BASE)
  await host.fill('#name', 'P1')
  await host.click('[data-act=host]')
  const link = await host.locator('#share').inputValue()
  for (const [i, g] of guests.entries()) {
    await g.goto(link)
    await g.fill('#name', `P${i + 2}`)
    await g.click('[data-act=join]')
    await expect(host.locator('.players li')).toHaveCount(i + 2)
  }
  await host.selectOption('#rounds', '1')
  await host.click('[data-act=start]')
  for (const g of guests) await expect(g.locator('.board')).toBeVisible()

  const phase = () => host.evaluate(() => window.__stigits!.snapshot()?.game?.phase)
  for (let i = 0; i < 4000 && (await phase()) !== 'gameOver'; i++) {
    let moved = false
    for (const p of pages) if (!moved) moved = await p.evaluate(() => window.__stigits!.autoMove())
    await host.waitForTimeout(moved ? 15 : 50)
  }
  for (const p of pages) await expect(p.locator('.dialog h2')).toContainText('wins')
  const states = await Promise.all(pages.map((p) => p.evaluate(() => window.__stigits!.snapshot()!.game)))
  for (const s of states) expect(s).toEqual(states[0])
  expect(states[0]!.players.map((p) => p.name)).toEqual(['P1', 'P2', 'P3', 'P4'])
})

// Only meaningful once TURN credentials are configured in the deployed build.
test('connects through the TURN relay only', async ({ browser }) => {
  test.skip(!process.env.E2E_RELAY, 'set E2E_RELAY=1 once TURN credentials are deployed')
  const host = await (await browser.newContext()).newPage()
  const guest = await (await browser.newContext()).newPage()
  await host.goto(BASE + '?relay=1')
  await host.click('[data-act=host]')
  const code = (await host.locator('#share').inputValue()).split('join=')[1]
  await guest.goto(`${BASE}?relay=1#join=${code}`)
  await guest.click('[data-act=join]')
  await expect(host.locator('.players li')).toHaveCount(2, { timeout: 20_000 })
})
