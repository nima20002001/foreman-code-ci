import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { SettingsChoice } from './SettingsCards'
import { WorkflowDefaultsSettings } from './WorkflowDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'

afterEach(() => { cleanup(); clearRevisionedFormPersistence() })

it('keeps the settings choice keyboard-accessible with footer actions outside its button', async () => {
  const onSelect = vi.fn()
  const props = { title: 'Codex', description: 'Coding defaults', summary: [{ label: 'Model', value: 'saved-model' }], onSelect }
  const view = render(<SettingsChoice {...props} />)
  const choice = screen.getByRole('button', { name: 'Edit Codex defaults' })
  expect(screen.queryByText('Edit defaults')).not.toBeInTheDocument()
  choice.focus()
  await userEvent.keyboard('{Enter}')
  expect(onSelect).toHaveBeenCalledOnce()
  view.rerender(<SettingsChoice {...props} footer={<button type="button">Install</button>} />)
  expect(screen.getByRole('button', { name: 'Install' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Edit Codex defaults' })).toBe(choice)
  expect(choice).not.toContainElement(screen.getByRole('button', { name: 'Install' }))
})

it.each(['user', 'native'])('retains %s approval selection, revision checks, and saved readback in workflow defaults', async (selection) => {
  let current = { value: { approvalHandler: 'orchestrator' }, revision: 1, versionId: null }
  server.use(http.get('/api/management/settings/workflows', () => HttpResponse.json(current)),
    http.put('/api/management/settings/workflows', async ({ request }) => {
      const input = await request.json() as { expectedRevision: number; value: { approvalHandler: string } }
      expect(input.expectedRevision).toBe(1)
      expect(input.value).toEqual({ approvalHandler: selection })
      current = { ...current, value: input.value, revision: 2 }
      return HttpResponse.json({ value: current, replayed: false })
    }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><WorkflowDefaultsSettings /></QueryClientProvider>)
  const user = userEvent.setup()
  const handler = await screen.findByRole('combobox', { name: 'Approval handler' })
  expect(handler).toHaveValue('orchestrator')
  expect(screen.getByRole('heading', { name: 'Approval routing' })).toBeVisible()
  await user.selectOptions(handler, selection)
  await user.click(screen.getByRole('button', { name: 'Save workflow defaults' }))
  expect(await screen.findByText('Changes saved to the server')).toBeVisible()
  expect(handler).toHaveValue(selection)
  view.unmount()
  client.clear()
})
