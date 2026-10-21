import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LocalHumanAccessSchema,
  MAX_PROMPT_TEXT_LENGTH,
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  type ManagementGrant,
  type PromptSettingUpdateInput,
} from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import type { PromptSettingsPage } from '../../shared/api/promptSettings'
import { PromptSettings } from './PromptSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'

const clients: QueryClient[] = []
const pages = [
  { page: 'system-prompt', label: 'System prompt', saveLabel: 'Save system prompt' },
  { page: 'operator-initial-prompt', label: 'Initial prompt', saveLabel: 'Save initial prompt' },
] as const

function access(grants: ManagementGrant[] = [{ actions: ['settings:read', 'settings:update'], scope: {} }]) {
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({
    principal: { id: 'prompt-owner', name: 'Owner', expiresAt: '2099-01-01T00:00:00Z', grants },
  }))))
}

function snapshot(text: string, revision = 3) {
  return ManagedPromptSettingSchema.parse({ value: { text }, revision, versionId: `prompt-${revision}` })
}

function mount(page: PromptSettingsPage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><PromptSettings page={page} /></QueryClientProvider>)
}

beforeEach(() => {
  clearRevisionedFormPersistence()
  access()
})

afterEach(() => {
  cleanup()
  clearRevisionedFormPersistence()
  for (const client of clients.splice(0)) client.clear()
})

describe('Prompt settings', () => {
  it.each(pages)('limits $page input using the shared prompt text bound', async (page) => {
    const startingText = 'x'.repeat(MAX_PROMPT_TEXT_LENGTH - 1)
    server.use(http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(snapshot(startingText))))
    mount(page.page)
    const editor = await screen.findByRole('textbox', { name: page.label })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await userEvent.type(editor, 'ab')
    expect(editor).toHaveValue(`${startingText}a`)
  })

  it.each(pages)('saves $page with its revision and reads the persisted text after reopening', async (page) => {
    let saved = snapshot('Original instructions')
    const writes: PromptSettingUpdateInput[] = []
    server.use(
      http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(saved)),
      http.put(`/api/management/settings/${page.page}`, async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes.push(input)
        saved = snapshot(input.value.text, saved.revision + 1)
        return HttpResponse.json({ value: saved, replayed: false })
      }),
    )
    const view = mount(page.page)
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: page.label })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    expect(editor).toHaveValue('Original instructions')
    await user.clear(editor)
    await user.type(editor, 'Instructions for new sessions\nPreserve this line.')
    await user.click(screen.getByRole('button', { name: page.saveLabel }))
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(screen.queryByText(/The (system|initial) prompt is saved/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: `About ${page.label}` }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(page.page === 'system-prompt'
      ? 'Newly started Agent sessions will use this revision.' : 'New Operator conversations will use this revision.')
    await user.unhover(screen.getByRole('button', { name: `About ${page.label}` }))
    expect(screen.getByText('Saved revision: 4')).toBeVisible()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ expectedRevision: 3,
      value: { text: 'Instructions for new sessions\nPreserve this line.' } })
    expect(writes[0]?.commandId).toEqual(expect.any(String))
    expect(screen.getByRole('button', { name: page.saveLabel })).toBeDisabled()

    view.unmount()
    clearRevisionedFormPersistence()
    mount(page.page)
    expect(await screen.findByRole('textbox', { name: page.label }))
      .toHaveValue('Instructions for new sessions\nPreserve this line.')
    expect(screen.getByText('Saved revision: 4')).toBeVisible()
  })

  it.each(pages)('clears $page and reads the empty saved prompt after reopening', async (page) => {
    let saved = snapshot('Instructions to remove')
    const writes: PromptSettingUpdateInput[] = []
    server.use(
      http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(saved)),
      http.put(`/api/management/settings/${page.page}`, async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes.push(input)
        saved = snapshot(input.value.text, 4)
        return HttpResponse.json({ value: saved, replayed: false })
      }),
    )
    const view = mount(page.page)
    const editor = await screen.findByRole('textbox', { name: page.label })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await userEvent.clear(editor)
    await userEvent.click(screen.getByRole('button', { name: page.saveLabel }))
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ expectedRevision: 3, value: { text: '' } })

    view.unmount()
    clearRevisionedFormPersistence()
    mount(page.page)
    expect(await screen.findByRole('textbox', { name: page.label })).toHaveValue('')
    expect(screen.getByText('Saved revision: 4')).toBeVisible()
    expect(screen.getByRole('button', { name: page.saveLabel })).toBeDisabled()
  })

  it.each(pages)('locks $page while a save is pending and prevents another submission', async (page) => {
    let writes = 0
    let finishSave: () => void = () => {}
    const pendingSave = new Promise<void>(resolve => { finishSave = resolve })
    server.use(
      http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(snapshot('Original instructions'))),
      http.put(`/api/management/settings/${page.page}`, async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes += 1
        await pendingSave
        return HttpResponse.json({ value: snapshot(input.value.text, 4), replayed: false })
      }),
    )
    mount(page.page)
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: page.label })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await user.type(editor, '\nAdded instructions')
    const save = screen.getByRole('button', { name: page.saveLabel })
    await user.click(save)
    await waitFor(() => expect(writes).toBe(1))
    expect(save).toBeDisabled()
    expect(save).toHaveTextContent('Saving…')
    expect(editor).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh saved prompt' })).toBeDisabled()
    await user.click(save)
    expect(writes).toBe(1)

    finishSave()
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(editor).toBeEnabled()
    expect(editor).toHaveValue('Original instructions\nAdded instructions')
    expect(screen.getByText('Saved revision: 4')).toBeVisible()
  })

  it.each(pages)('preserves $page edits after a definitive rejection and allows a corrected save', async (page) => {
    const writes: PromptSettingUpdateInput[] = []
    server.use(
      http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(snapshot('Original instructions'))),
      http.put(`/api/management/settings/${page.page}`, async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes.push(input)
        if (writes.length === 1) {
          return HttpResponse.json({ error: {
            code: 'INVALID_REQUEST', message: 'Review this prompt before saving.',
          } }, { status: 400 })
        }
        return HttpResponse.json({ value: snapshot(input.value.text, 4), replayed: false })
      }),
    )
    mount(page.page)
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: page.label })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await user.clear(editor)
    await user.type(editor, 'Draft instructions')
    await user.click(screen.getByRole('button', { name: page.saveLabel }))
    expect(await screen.findByText('Prompt was not saved')).toBeVisible()
    expect(screen.getByText(/Review this prompt before saving/)).toBeVisible()
    expect(editor).toBeEnabled()
    expect(editor).toHaveValue('Draft instructions')
    expect(screen.queryByText('Prompt saved')).not.toBeInTheDocument()
    await user.type(editor, '\nCorrection')
    expect(screen.queryByText('Prompt was not saved')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: page.saveLabel }))
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(writes[1]).toMatchObject({ expectedRevision: 3, value: { text: 'Draft instructions\nCorrection' } })
    expect(writes[1]?.commandId).not.toBe(writes[0]?.commandId)
  })

  it('loads the saved prompt after retrying a failed request', async () => {
    let reads = 0
    server.use(http.get('/api/management/settings/system-prompt', () => {
      reads += 1
      if (reads === 1) {
        return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Prompt could not be loaded.' } },
          { status: 503 })
      }
      return HttpResponse.json(snapshot('Recovered instructions'))
    }))
    mount('system-prompt')
    expect(await screen.findByText('System prompt is unavailable')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('textbox', { name: 'System prompt' })).toHaveValue('Recovered instructions')
    expect(reads).toBe(2)
  })

  it('preserves edited text after a revision conflict until the owner chooses it and saves again', async () => {
    let saved = snapshot('Original instructions')
    const writes: PromptSettingUpdateInput[] = []
    server.use(
      http.get('/api/management/settings/system-prompt', () => HttpResponse.json(saved)),
      http.put('/api/management/settings/system-prompt', async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes.push(input)
        if (writes.length === 1) {
          saved = snapshot('Instructions saved elsewhere', 4)
          return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Prompt changed.' } }, { status: 409 })
        }
        saved = snapshot(input.value.text, 5)
        return HttpResponse.json({ value: saved, replayed: false })
      }),
    )
    mount('system-prompt')
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: 'System prompt' })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await user.clear(editor)
    await user.type(editor, 'My instructions')
    await user.click(screen.getByRole('button', { name: 'Save system prompt' }))
    expect(await screen.findByText('This prompt changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(editor).toHaveValue('My instructions')
    await user.click(screen.getByText('Current saved prompt'))
    expect(screen.getByText('Instructions saved elsewhere')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save system prompt' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Keep my text with the current revision' }))
    await user.click(screen.getByRole('button', { name: 'Save system prompt' }))
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(writes[1]).toMatchObject({ expectedRevision: 4, value: { text: 'My instructions' } })
    expect(writes[1]?.commandId).not.toBe(writes[0]?.commandId)
    expect(screen.getByText('Saved revision: 5')).toBeVisible()
  })

  it('locks uncertain edits and retries the original Operator prompt save without changing its command', async () => {
    let saved = snapshot('Original Operator prompt')
    const writes: PromptSettingUpdateInput[] = []
    server.use(
      http.get('/api/management/settings/operator-initial-prompt', () => HttpResponse.json(saved)),
      http.put('/api/management/settings/operator-initial-prompt', async ({ request }) => {
        const input = PromptSettingUpdateInputSchema.parse(await request.json())
        writes.push(input)
        saved = snapshot(input.value.text, 4)
        if (writes.length === 1) {
          return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Acknowledgement lost.' } }, { status: 503 })
        }
        return HttpResponse.json({ value: saved, replayed: true })
      }),
    )
    mount('operator-initial-prompt')
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await user.clear(editor)
    await user.type(editor, 'New Operator prompt')
    await user.click(screen.getByRole('button', { name: 'Save initial prompt' }))
    expect(await screen.findByText('Save not confirmed')).toBeVisible()
    expect(editor).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save initial prompt' }))
    expect(await screen.findByText('Prompt saved')).toBeVisible()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(editor).toHaveValue('New Operator prompt')
    expect(editor).toBeEnabled()
  })

  it.each(pages)('keeps $page read-only without a global update grant', async (page) => {
    access([
      { actions: ['settings:read'], scope: {} },
      { actions: ['settings:update'], scope: { workspaceIds: ['workspace-a'] } },
    ])
    server.use(http.get(`/api/management/settings/${page.page}`, () => HttpResponse.json(snapshot('Readable instructions'))))
    mount(page.page)
    const editor = await screen.findByRole('textbox', { name: page.label })
    expect(await screen.findByText('You have read-only access to this prompt.')).toBeVisible()
    expect(editor).toHaveAttribute('readonly')
    await userEvent.type(editor, 'Forbidden edit')
    expect(editor).toHaveValue('Readable instructions')
    expect(screen.queryByRole('button', { name: page.saveLabel })).not.toBeInTheDocument()
  })

  it('hides the prompt editor when a save loses permission', async () => {
    server.use(
      http.get('/api/management/settings/system-prompt', () => HttpResponse.json(snapshot('Original instructions'))),
      http.put('/api/management/settings/system-prompt', () => HttpResponse.json({
        error: { code: 'FORBIDDEN', message: 'Prompt updates are denied.' },
      }, { status: 403 })),
    )
    mount('system-prompt')
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: 'System prompt' })
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
    await user.type(editor, 'Updated')
    await user.click(screen.getByRole('button', { name: 'Save system prompt' }))
    expect(await screen.findByText('Access unavailable')).toBeVisible()
    expect(screen.getByText('Prompt updates are denied.')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save system prompt' })).not.toBeInTheDocument()
  })
})
