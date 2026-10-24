import { expect, test, type Page } from '@playwright/test'

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

    // First move through the real UI: tap a stick, then tap a highlighted spot.
    await host.locator('.hit[data-stick]').first().waitFor({ state: 'attached' })
    const sticks = host.locator('.hit[data-stick]')
    for (let i = 0; i < (await sticks.count()); i++) {
      await sticks.nth(i).dispatchEvent('click')
      if (await host.locator('.hit[data-target]').count()) break
    }
    await host.locator('.hit[data-target]').first().dispatchEvent('click')
    await expect.poll(() => guest.evaluate(() => window.__stigits!.snapshot()!.game!.lastMove !== null)).toBe(true)
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
