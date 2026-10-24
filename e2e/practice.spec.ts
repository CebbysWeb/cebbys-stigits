import { expect, test } from '@playwright/test'

const BASE = process.env.E2E_URL ?? 'http://localhost:4173/'

test('offline practice against three bots, seated around the table', async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(BASE)
  await page.fill('#name', 'Solo')
  await page.click('[data-act=practice]')
  await page.click('[data-act=add-bot]')
  await page.click('[data-act=add-bot]')
  await expect(page.locator('.players li')).toHaveCount(4)
  await page.selectOption('#rounds', '1')
  await page.click('[data-act=start]')

  // Me at the bottom; the next three players in turn order sit left, top and right.
  const names = await page.evaluate(() => window.__stigits!.snapshot()!.game!.players.map((p) => p.name))
  for (const [pos, name] of [['bottom', 'Solo'], ['left', names[1]], ['top', names[2]], ['right', names[3]]])
    await expect(page.locator(`.seat-${pos} .seat-label b`)).toContainText(name)
  await expect(page.locator('.seat-left .fan.small .hand-card')).toHaveCount(5)
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'e2e/results/practice-table.png' })

  // Bots move on their own; I auto-play my turns until the game is scored.
  for (let i = 0; i < 3000; i++) {
    const phase = await page.evaluate(() => window.__stigits!.snapshot()!.game!.phase)
    if (phase === 'gameOver') break
    await page.evaluate(() => window.__stigits!.autoMove())
    await page.waitForTimeout(100)
  }
  await expect(page.locator('.dialog h2')).toContainText('wins')
})
