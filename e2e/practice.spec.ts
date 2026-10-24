import { expect, test } from '@playwright/test'
import { dragStick, playCardByDrag } from './helpers'

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

  const me = () => page.evaluate(() => {
    const g = window.__stigits!.snapshot()!.game!
    const p = g.players.find((x) => x.id === window.__stigits!.myId())!
    return { score: p.score, hand: p.hand, phase: g.phase, moveCount: g.moveCount }
  })

  // A wrong call costs a point and shakes the card, which stays in hand.
  const wrong = await page.evaluate(() => {
    const g = window.__stigits!.snapshot()!.game!
    const p = g.players.find((x) => x.id === window.__stigits!.myId())!
    const before = g.moveCount
    return { card: p.hand.find((c) => !window.__stigits!.matches(c))!, before }
  })
  const start = await me()
  await playCardByDrag(page, wrong.card)
  await expect(page.locator('.toast')).toContainText('Not a match')
  await expect(page.locator(`.hand-card[data-card="${wrong.card}"].wrong`)).toHaveCount(1)
  await expect.poll(async () => (await me()).score).toBe(start.score - 1)
  expect((await me()).hand).toContain(wrong.card)

  // Play to the end. Whenever I hold the shape on the grid I play it by dragging it up.
  let realPlays = 0
  for (let i = 0; i < 3000; i++) {
    const state = await me()
    if (state.phase === 'gameOver') break
    const match = await page.evaluate(() => window.__stigits!.snapshot()!.game!.players
      .find((x) => x.id === window.__stigits!.myId())!.hand.find((c) => window.__stigits!.matches(c)))
    if (match !== undefined) {
      await page.locator('.seat.me .fan').scrollIntoViewIfNeeded()
      await playCardByDrag(page, match)
      await expect.poll(async () => (await me()).hand.includes(match) && (await me()).moveCount === state.moveCount).toBe(false)
      if (!(await me()).hand.includes(match)) realPlays++
      continue
    }
    await page.evaluate(() => window.__stigits!.autoMove())
    await page.waitForTimeout(100)
  }
  await expect(page.locator('.dialog h2')).toContainText('wins')
  expect(realPlays).toBeGreaterThan(0)
})

test('drags never get stuck when the screen redraws mid-drag', async ({ browser }) => {
  test.setTimeout(120_000)
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(BASE)
  await page.click('[data-act=practice]')
  await page.click('[data-act=start]')
  const myTurn = () => page.evaluate(() => {
    const g = window.__stigits!.snapshot()!.game!
    return g.phase === 'playing' && g.players[g.current].id === window.__stigits!.myId()
  })
  const lastMove = () => page.evaluate(() => JSON.stringify(window.__stigits!.snapshot()!.game!.lastMove))

  for (let round = 0; round < 3; round++) {
    await expect.poll(myTurn, { timeout: 10_000 }).toBe(true)
    const before = await lastMove()
    await dragStick(page)
    await expect.poll(lastMove).not.toBe(before)
    if (await page.evaluate(() => window.__stigits!.snapshot()!.game!.phase) !== 'playing') break

    // The bot moves while I hold a card: the redraw must not leave the card stuck.
    const order = await page.evaluate(() => window.__stigits!.handOrder())
    if (order.length > 1) {
      const box = (await page.locator(`.hand-card[data-card="${order[0]}"]`).boundingBox())!
      const botMove = await lastMove()
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
      await page.mouse.down()
      for (let i = 0; i < 30 && (await lastMove()) === botMove; i++) await page.mouse.move(box.x + 30 + i * 4, box.y + box.height / 2)
      // Release far from the card, outside the hand.
      await page.mouse.move(640, 120, { steps: 3 })
      await page.mouse.up()
      await expect(page.locator('.hand-card.dragging')).toHaveCount(0)
    }

    // A right-button drag on the board must not pan or lock anything.
    await page.mouse.move(300, 400)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(400, 450)
    await page.mouse.up({ button: 'right' })
  }
  // Nothing got selected as text along the way.
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('')
})

test('cards are square and a held card turns with R / E and mirrors with F', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(BASE)
  await page.click('[data-act=practice]')
  await page.click('[data-act=start]')
  const card = (await page.evaluate(() => window.__stigits!.handOrder()))[0]
  const el = page.locator(`.hand-card[data-card="${card}"]`)
  await page.waitForTimeout(700) // let the deal animation settle
  const box = (await el.boundingBox())!
  const size = await el.evaluate((e) => [e.offsetWidth, e.offsetHeight])
  expect(Math.abs(size[0] - size[1])).toBeLessThanOrEqual(1)

  const shape = el.locator('.card-shape')
  const transform = () => shape.evaluate((e) => (e as SVGElement).style.transform)
  // Keys do nothing unless the card is held.
  await page.keyboard.press('r')
  expect(await transform()).toBe('')

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.2 + 5, box.y + box.height / 2)
  await page.keyboard.press('r')
  expect(await transform()).toBe('scaleX(1) rotate(90deg)')
  await page.keyboard.press('r')
  await page.keyboard.press('e')
  expect(await transform()).toBe('scaleX(1) rotate(90deg)')
  await page.keyboard.press('f')
  expect(await transform()).toBe('scaleX(-1) rotate(90deg)')
  // Mirrored, R still turns clockwise on screen.
  await page.keyboard.press('r')
  expect(await transform()).toBe('scaleX(-1) rotate(0deg)')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'e2e/results/card-rotated.png' })
  await page.mouse.up()
  // The orientation sticks after letting go.
  expect(await transform()).toBe('scaleX(-1) rotate(0deg)')
})
