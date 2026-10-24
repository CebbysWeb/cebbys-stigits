import { expect, type Page } from '@playwright/test'

export const center = async (p: Page, selector: string) => {
  const r = await p.locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  return r
}

/** Press on a movable stick, drag it to the first highlighted spot and release. */
export async function dragStick(p: Page): Promise<void> {
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


/** Drag a card from the hand up onto the board to play it. */
export async function playCardByDrag(p: Page, card: number): Promise<void> {
  const box = (await p.locator(`.seat.me .hand-card[data-card="${card}"]`).boundingBox())!
  const x = box.x + box.width * 0.25
  await p.mouse.move(x, box.y + box.height / 2)
  await p.mouse.down()
  await p.mouse.move(x, box.y - 60, { steps: 4 })
  await p.mouse.move(x, box.y - 200, { steps: 4 })
  await expect(p.locator(`.seat.me .hand-card[data-card="${card}"].will-play`)).toHaveCount(1)
  await p.mouse.up()
}
