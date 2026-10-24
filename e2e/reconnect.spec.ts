import { expect, test } from '@playwright/test'

// Dropped players get their seat back: a reloaded guest rejoins, a reloaded host
// reopens the game under the same code and the guest reconnects by itself.
// Needs internet access for the public PeerJS signaling server.
const BASE = process.env.E2E_URL ?? 'http://localhost:4173/'

test('guest rejoins and host resumes after a reload', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  const guest = await (await browser.newContext()).newPage()

  await host.goto(BASE)
  await host.fill('#name', 'Hosty')
  await host.click('[data-act=host]')
  const link = await host.locator('#share').inputValue()
  await guest.goto(link)
  await guest.fill('#name', 'Guesty')
  await guest.click('[data-act=join]')
  await expect(host.locator('.players li')).toHaveCount(2)
  await host.click('[data-act=start]')
  await expect(guest.locator('.board')).toBeVisible()
  const guestId = await guest.evaluate(() => window.__stigits!.myId())

  // The guest reloads: the host marks them offline, then the home screen offers to rejoin.
  await guest.goto(BASE)
  await expect(host.locator('.seat .off')).toHaveCount(1)
  await guest.click('[data-act=rejoin]')
  await expect(guest.locator('.board')).toBeVisible()
  expect(await guest.evaluate(() => window.__stigits!.myId())).toBe(guestId)
  await expect(host.locator('.seat .off')).toHaveCount(0)

  // The host reloads: the guest starts reconnecting while the host reopens the game.
  const moves = await host.evaluate(() => window.__stigits!.snapshot()!.game!.moveCount)
  await host.reload()
  await expect(guest.locator('.net-bar.show.reconnecting')).toBeVisible({ timeout: 20_000 })
  await host.click('[data-act=resume]')
  await expect(host.locator('.board')).toBeVisible({ timeout: 30_000 })
  await expect(guest.locator('.net-bar.show')).toHaveCount(0, { timeout: 30_000 })
  await expect(host.locator('.seat .off')).toHaveCount(0)
  expect(await host.evaluate(() => window.__stigits!.snapshot()!.game!.moveCount)).toBe(moves)

  // Leaving for good: nothing is offered to resume.
  host.once('dialog', (d) => d.accept())
  await host.click('[data-act=quit]')
  await expect(host.locator('[data-act=resume]')).toHaveCount(0)
})
