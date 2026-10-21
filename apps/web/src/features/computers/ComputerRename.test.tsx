import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ComputerRenameResult } from '@foreman-code/contracts/computer-activity'
import { ComputerCards } from './ComputerCards'
import { computersFixture, mainId, mainTarget } from './computersTestFixture'

type Rename = { target: typeof mainTarget; name: string }
function renderMain(failWith?: number) {
  const saved: Rename[] = []
  const fixture = computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    http.post('*/api/management/computers/rename', async ({ request }) => {
      const body = await request.json() as Rename
      saved.push(body)
      if (failWith) return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Needs settings update.' } }, { status: failWith })
      fixture.activity.computers.find(computer => computer.target.hostRef.kind === 'main')!.name = body.name
      return HttpResponse.json({ target: body.target, name: body.name } satisfies ComputerRenameResult)
    }),
  ])
  return { saved, ...fixture }
}

it('renames a computer on Enter and shows the saved name from the readback', async () => {
  const { saved } = renderMain()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Main PC' }))
  const input = screen.getByRole('textbox', { name: 'Computer name' })
  await user.clear(input)
  await user.type(input, '  Studio desktop {Enter}')
  expect(await screen.findByRole('article', { name: 'Studio desktop' })).toBeVisible()
  expect(saved).toEqual([{ target: mainTarget, name: 'Studio desktop' }])
})

it('saves when the field loses focus', async () => {
  const { saved } = renderMain()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Main PC' }))
  const input = screen.getByRole('textbox', { name: 'Computer name' })
  await user.clear(input)
  await user.type(input, 'Office PC')
  await user.tab()
  expect(await screen.findByRole('article', { name: 'Office PC' })).toBeVisible()
  expect(saved).toHaveLength(1)
})

it('cancels on Escape and ignores empty or unchanged names', async () => {
  const { saved } = renderMain()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Main PC' }))
  await user.type(screen.getByRole('textbox', { name: 'Computer name' }), 'x{Escape}')
  expect(await screen.findByRole('button', { name: 'Main PC' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Main PC' }))
  await user.clear(screen.getByRole('textbox', { name: 'Computer name' }))
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('button', { name: 'Main PC' }))
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Main PC' })).toBeVisible()
  expect(saved).toEqual([])
})

it('keeps the old name and says why when the save is refused', async () => {
  renderMain(403)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Main PC' }))
  await user.type(screen.getByRole('textbox', { name: 'Computer name' }), ' two{Enter}')
  const card = await screen.findByRole('article', { name: 'Main PC' })
  await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('Needs settings update.'))
  expect(within(card).getByRole('button', { name: 'Main PC' })).toBeVisible()
})
