import { expect, test, type Page } from '@playwright/test'

async function ready(page: Page) {
  await expect(page.getByTestId('note-input')).toBeVisible()
}

async function addNote(page: Page, text: string) {
  await page.getByTestId('note-input').fill(text)
  await page.getByTestId('add-note').click()
}

async function persisted(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('field-notes') ?? '')
}

async function waitUntilStored(page: Page, snippet: string) {
  await expect.poll(() => persisted(page)).toContain(snippet)
}

test('shows the editor after hydration', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await expect(page.getByTestId('empty-notes')).toBeVisible()
  await expect(page.getByTestId('theme-value')).toHaveText('light')
  await expect(page.getByTestId('note-count')).toHaveText('0')
})

test('keeps a note after reload', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, 'Buy tape')
  await expect(page.getByTestId('note-text')).toHaveText('Buy tape')
  await waitUntilStored(page, 'Buy tape')

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('note-text')).toHaveText('Buy tape')
  await expect(page.getByTestId('note-count')).toHaveText('1')
})

test('keeps note order after reload', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, 'First')
  await addNote(page, 'Second')
  await expect(page.getByTestId('note-text')).toHaveText(['First', 'Second'])
  await waitUntilStored(page, 'Second')

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('note-text')).toHaveText(['First', 'Second'])
})

test('deletes one note and keeps the other after reload', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, 'Keep me')
  await addNote(page, 'Drop me')
  await page.getByTestId('delete-note').nth(1).click()
  await expect(page.getByTestId('note-text')).toHaveText('Keep me')
  await waitUntilStored(page, 'Keep me')
  await expect.poll(() => persisted(page)).not.toContain('Drop me')

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('note-text')).toHaveText('Keep me')
  await expect(page.getByTestId('empty-notes')).toHaveCount(0)
})

test('ignores a blank note', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, '   ')
  await expect(page.getByTestId('empty-notes')).toBeVisible()
  await expect(page.getByTestId('note-count')).toHaveText('0')
})

test('keeps the theme after reload', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await page.getByTestId('theme-toggle').click()
  await expect(page.getByTestId('theme-value')).toHaveText('dark')
  await waitUntilStored(page, 'dark')

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('theme-value')).toHaveText('dark')
})

test('clears saved notes so a reload starts empty', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, 'Temporary')
  await page.getByTestId('theme-toggle').click()
  await page.getByTestId('clear-storage').click()
  await expect(page.getByTestId('empty-notes')).toBeVisible()
  await expect(page.getByTestId('theme-value')).toHaveText('light')

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('empty-notes')).toBeVisible()
  await expect(page.getByTestId('theme-value')).toHaveText('light')
  await expect(page.getByTestId('note-count')).toHaveText('0')
})

test('does not restore a note that was cleared before the debounce flush', async ({
  page,
}) => {
  await page.goto('/')
  await ready(page)
  await addNote(page, 'Race')
  await page.getByTestId('clear-storage').click()
  await page.waitForTimeout(200)

  await page.reload()
  await ready(page)
  await expect(page.getByTestId('empty-notes')).toBeVisible()
})
