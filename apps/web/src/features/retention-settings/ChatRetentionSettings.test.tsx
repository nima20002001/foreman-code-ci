import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  FileRetentionGetResultSchema, FileRetentionPreferenceSchema, FileRetentionPreviewInputSchema,
  FileRetentionPreviewResultSchema, FileRetentionSaveInputSchema, FileRetentionSaveResultSchema,
  type FileRetentionPreference, type FileRetentionPreviewResult, type FileRetentionSaveInput,
  type FileRetentionSaveResult,
} from '@foreman-code/contracts/files'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { ChatRetentionSettings } from './ChatRetentionSettings'
import { retentionQueryKey } from './retentionQueries'
import { clearRetentionCommandMemory, retentionCommandKey } from './retentionCommand'
import { beginSessionChange, finishSessionChange, sessionGeneration } from '../../shared/api/sessionBoundary'
import { deferred } from '../../test/deferred'

const root = '/api/management/file-retention'
const clients: QueryClient[] = []
let preference: FileRetentionPreference
let saves: FileRetentionSaveInput[]
let previews: number[]
let expireNowCount: number
let receipts: Map<string, { input: FileRetentionSaveInput; result: FileRetentionSaveResult }>

function rejection(code: string, status: number) {
  return HttpResponse.json({ error: { code, message: code } }, { status })
}
function currentPreview(durationSeconds: number): FileRetentionPreviewResult {
  return FileRetentionPreviewResultSchema.parse({
    ownerPrincipalId: preference.ownerPrincipalId, preferenceRevision: preference.revision, durationSeconds,
    asOfUtc: '2026-09-28T05:00:00.000Z', expireNowCount,
  })
}
function accept(input: FileRetentionSaveInput) {
  preference = FileRetentionPreferenceSchema.parse({
    ...preference, durationSeconds: input.durationSeconds, revision: (input.expectedRevision ?? preference.revision) + 1,
  })
  const result = FileRetentionSaveResultSchema.parse({
    value: {
      preference: { ...preference }, updatedFileCount: input.applyToExisting ? expireNowCount : 0,
      expiredNowCount: input.applyToExisting ? expireNowCount : 0,
    }, replayed: false,
  })
  receipts.set(input.commandId, { input, result })
  return result
}
function mount() {
  // Deliberately hostile global defaults: feature mutations must override automatic retries.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}><ChatRetentionSettings /></QueryClientProvider>)
  return { ...view, client }
}
async function duration() { return screen.findByRole('spinbutton', { name: 'Duration' }) }
async function setDuration(amount: string, unit: 'hours' | 'days' = 'days') {
  const user = userEvent.setup()
  const input = await duration()
  await user.clear(input)
  if (amount) await user.type(input, amount)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), unit)
  return user
}
async function save(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: /^Save$/ })
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
}

function clearRecovery() {
  clearRetentionCommandMemory()
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.includes(':outbox:file-retention%3A')) window.sessionStorage.removeItem(key)
  }
}

beforeEach(() => {
  clearRecovery()
  clearRevisionedFormPersistence()
  preference = FileRetentionPreferenceSchema.parse({ ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0 })
  saves = []
  previews = []
  expireNowCount = 0
  receipts = new Map()
  server.use(
    http.get(root, () => HttpResponse.json(FileRetentionGetResultSchema.parse({ preference }))),
    http.post(`${root}/preview`, async ({ request }) => {
      const { durationSeconds } = FileRetentionPreviewInputSchema.parse(await request.json())
      previews.push(durationSeconds)
      return HttpResponse.json(currentPreview(durationSeconds))
    }),
    http.post(root, async ({ request }) => {
      // Strict parsing rejects accidental owner, workspace or workflow selectors.
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      const receipt = receipts.get(input.commandId)
      if (receipt) {
        if (JSON.stringify(receipt.input) !== JSON.stringify(input)) return rejection('COMMAND_ID_CONFLICT', 409)
        return HttpResponse.json({ ...receipt.result, replayed: true })
      }
      if (input.expectedRevision !== preference.revision) return rejection('REVISION_CONFLICT', 409)
      return HttpResponse.json(accept(input))
    }),
  )
})
afterEach(() => {
  cleanup()
  clearRecovery()
  clearRevisionedFormPersistence()
  for (const client of clients.splice(0)) client.clear()
})

describe('Chat retention through the real HTTP client and MSW', () => {
  it('loads the server default without a workspace, router, selected chat or owner input', async () => {
    mount()
    expect(await duration()).toHaveValue(7)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('days')
    expect(screen.getByRole('checkbox', { name: 'Apply to existing' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(saves).toHaveLength(0)
  })

  it('uses non-default server values rather than a hard-coded seven days', async () => {
    preference = { ...preference, durationSeconds: 5_400, revision: 5 }
    mount()
    expect(await duration()).toHaveValue(1.5)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('hours')
  })

  it('changes future retention and shows the persisted value after a cold remount', async () => {
    const view = mount()
    const user = await setDuration('12', 'hours')
    await save(user)
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ durationSeconds: 43_200, expectedRevision: 0, applyToExisting: false })
    expect(saves[0]?.commandId).toBeTruthy()
    expect(previews).toEqual([])
    view.unmount()
    view.client.clear()
    clearRevisionedFormPersistence()
    mount()
    expect(await duration()).toHaveValue(12)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('hours')
    expect(saves).toHaveLength(1)
  })

  it.each([['', 'hours'], ['0.5', 'hours'], ['8761', 'hours'], ['366', 'days'], ['1.0001', 'hours']] as const)(
    'keeps invalid %s %s out of both POST routes', async (amount, unit) => {
      mount()
      await setDuration(amount, unit)
      expect(screen.getByRole('spinbutton', { name: 'Duration' })).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByText('Use 1 hour–365 days.')).toBeVisible()
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
      expect(saves).toHaveLength(0)
      expect(previews).toHaveLength(0)
    },
  )

  it('keeps rejected input editable and does not claim it was saved', async () => {
    server.use(http.post(root, () => rejection('VALIDATION_FAILED', 400)))
    mount()
    const user = await setDuration('2')
    await save(user)
    expect(await screen.findByText('Could not save. Your edit is kept.')).toBeVisible()
    expect(await duration()).toHaveValue(2)
    expect(await duration()).toBeEnabled()
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
  })

  it('keeps the draft on conflict and requires explicit reapplication to the fresh revision', async () => {
    mount()
    const user = await setDuration('2')
    preference = { ...preference, durationSeconds: 864_000, revision: 1 }
    await save(user)
    expect(await screen.findByText(/Changed elsewhere. Your edit is kept./)).toBeVisible()
    expect(await duration()).toHaveValue(2)
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(saves).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Use my value' }))
    await save(user)
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves.map((input) => input.expectedRevision)).toEqual([0, 1])
    expect(saves[0]?.commandId).not.toBe(saves[1]?.commandId)
    expect(preference.durationSeconds).toBe(172_800)
  })

  it('shows the preview count and makes no write until explicit confirmation', async () => {
    expireNowCount = 3
    mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to existing?' })
    expect(within(dialog).getByText('3 files would expire now.')).toBeVisible()
    expect(previews).toEqual([3_600])
    expect(saves).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Apply and save' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ durationSeconds: 3_600, expectedRevision: 0, applyToExisting: true })
    expect(screen.getByRole('checkbox', { name: 'Apply to existing' })).not.toBeChecked()
  })

  it('cancels from the shared backdrop and gets a fresh count for a different proposal', async () => {
    expireNowCount = 2
    mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to existing?' })
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'))
    expect(saves).toHaveLength(0)
    await setDuration('2', 'hours')
    expireNowCount = 1
    await save(user)
    expect(await screen.findByText('1 file would expire now.')).toBeVisible()
    expect(previews).toEqual([3_600, 7_200])
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(saves).toHaveLength(0)
  })

  it('previews extensions too, because older live files can have longer snapshots', async () => {
    preference = { ...preference, durationSeconds: 3_600 }
    expireNowCount = 4
    mount()
    const user = await setDuration('2', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    expect(await screen.findByText('4 files would expire now.')).toBeVisible()
    expect(saves).toHaveLength(0)
  })

  it('saves directly after a zero-count preview', async () => {
    mount()
    const user = await setDuration('30')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(previews).toEqual([2_592_000])
    expect(saves).toHaveLength(1)
    expect(saves[0]?.applyToExisting).toBe(true)
  })

  it('does not write when preview fails, and keeps input', async () => {
    server.use(http.post(`${root}/preview`, () => rejection('UNAVAILABLE', 503)))
    mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    expect(await screen.findByText('Could not check existing files.')).toBeVisible()
    expect(await duration()).toHaveValue(1)
    expect(saves).toHaveLength(0)
  })

  it.each(['owner', 'duration', 'revision'] as const)('rejects a preview for the wrong %s', async (field) => {
    server.use(http.post(`${root}/preview`, () => HttpResponse.json({
      ...currentPreview(3_600),
      ...(field === 'owner' ? { ownerPrincipalId: 'another-owner' }
        : field === 'duration' ? { durationSeconds: 7_200 } : { preferenceRevision: 99 }),
    })))
    mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    expect(await screen.findByText('Could not check existing files.')).toBeVisible()
    expect(saves).toHaveLength(0)
  })

  it('discards confirmation when a newer server revision arrives', async () => {
    expireNowCount = 2
    const view = mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to existing?' })
    preference = { ...preference, revision: 1, durationSeconds: 864_000 }
    await act(async () => {
      await view.client.refetchQueries({ queryKey: retentionQueryKey(sessionGeneration()) })
    })
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'))
    expect(saves).toHaveLength(0)
    expect(await duration()).toHaveValue(1)
  })

  it('a late zero-count preview after unmount never starts a save', async () => {
    const gate = deferred<FileRetentionPreviewResult>()
    server.use(http.post(`${root}/preview`, async ({ request }) => {
      const input = FileRetentionPreviewInputSchema.parse(await request.json())
      previews.push(input.durationSeconds)
      return HttpResponse.json(await gate.promise)
    }))
    const view = mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    await waitFor(() => expect(previews).toHaveLength(1))
    view.unmount()
    await act(async () => {
      gate.resolve(currentPreview(3_600))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(saves).toHaveLength(0)
  })

  it('coalesces rapid save clicks while the command is pending', async () => {
    const gate = deferred<void>()
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      await gate.promise
      return HttpResponse.json(accept(input))
    }))
    mount()
    await setDuration('2')
    const button = screen.getByRole('button', { name: /^Save$/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(await duration()).toBeDisabled()
    gate.resolve()
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(1)
  })

  it('never auto-retries a lost acknowledgement; remount retry uses the exact original command', async () => {
    let loseAck = true
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      if (loseAck) {
        loseAck = false
        accept(input)
        return HttpResponse.error()
      }
      const receipt = receipts.get(input.commandId)
      if (!receipt) return rejection('UNEXPECTED_NEW_COMMAND', 400)
      return HttpResponse.json({ ...receipt.result, replayed: true })
    }))
    expireNowCount = 2
    const view = mount()
    const user = await setDuration('1', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    await user.click(await screen.findByRole('button', { name: 'Apply and save' }))
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(await duration()).toBeDisabled()
    view.unmount()
    // Preserve the existing session's Zustand command, but use a cold QueryClient.
    mount()
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(2)
    expect(saves[1]).toEqual(saves[0])
    expect(preference.revision).toBe(1)
    expect(previews).toHaveLength(1)
  })

  it('does not forget a possibly accepted command when a later replay is denied', async () => {
    let phase: 'lost' | 'denied' | 'replay' = 'lost'
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      if (phase === 'lost') {
        accept(input)
        return HttpResponse.error()
      }
      if (phase === 'denied') return rejection('FORBIDDEN', 403)
      const receipt = receipts.get(input.commandId)
      return receipt ? HttpResponse.json({ ...receipt.result, replayed: true }) : rejection('UNEXPECTED_NEW_COMMAND', 400)
    }))
    mount()
    const user = await setDuration('2')
    await save(user)
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    phase = 'denied'
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(saves).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry save' })).toBeEnabled())
    expect(await duration()).toBeDisabled()
    phase = 'replay'
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(3)
    expect(saves[1]).toEqual(saves[0])
    expect(saves[2]).toEqual(saves[0])
    expect(preference.revision).toBe(1)
  })

  it('treats a malformed successful response as unknown, not a failed command', async () => {
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      accept(input)
      return HttpResponse.json({ ok: true })
    }))
    mount()
    const user = await setDuration('2')
    await save(user)
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(await duration()).toHaveValue(2)
  })

  it('retains command identity if POST succeeds but its GET readback fails', async () => {
    let failReadback = true
    server.use(http.get(root, () => preference.revision > 0 && failReadback
      ? rejection('FORBIDDEN', 403) : HttpResponse.json({ preference })))
    mount()
    const user = await setDuration('2')
    await save(user)
    // Query 403 hides protected fields, but the saved command stays in the shared form.
    expect(await screen.findByText('Chat retention is unavailable.')).toBeVisible()
    expect(saves).toHaveLength(1)
    failReadback = false
    await user.click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(2)
    expect(saves[1]).toEqual(saves[0])
    expect(preference.revision).toBe(1)
  })

  it('uses current GET readback rather than an older command receipt', async () => {
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      const historical = accept(input)
      // A different client saves between this accepted command and readback.
      preference = { ...preference, durationSeconds: 259_200, revision: 2 }
      return HttpResponse.json(historical)
    }))
    mount()
    const user = await setDuration('2')
    await save(user)
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(await duration()).toHaveValue(3)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('days')
  })

  it('keeps the server default hidden on a failed initial load and supports retry', async () => {
    let failing = true
    server.use(http.get(root, () => failing ? rejection('UNAVAILABLE', 503) : HttpResponse.json({ preference })))
    mount()
    expect(await screen.findByText('Chat retention is unavailable.')).toBeVisible()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    failing = false
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(await duration()).toHaveValue(7)
  })

  it('recovers the exact unknown command after all document memory and query caches are discarded', async () => {
    let loseAck = true
    server.use(http.post(root, async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      saves.push(input)
      if (loseAck) {
        loseAck = false
        accept(input)
        return rejection('SERVER_ERROR', 503)
      }
      const receipt = receipts.get(input.commandId)
      if (!receipt) return rejection('UNEXPECTED_NEW_COMMAND', 400)
      return HttpResponse.json({ ...receipt.result, replayed: true })
    }))
    expireNowCount = 2
    const view = mount()
    const user = await setDuration('24', 'hours')
    await user.click(screen.getByRole('checkbox', { name: 'Apply to existing' }))
    await save(user)
    await user.click(await screen.findByRole('button', { name: 'Apply and save' }))
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    const original = structuredClone(saves[0])
    view.unmount()
    view.client.clear()
    clearRevisionedFormPersistence()
    clearRetentionCommandMemory()
    // Retain only sessionStorage, exactly as a reload in the same authenticated tab does.
    mount()
    expect(await screen.findByText('Save unconfirmed. Retry safely.')).toBeVisible()
    expect(await duration()).toHaveValue(24)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('hours')
    expect(saves).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(saves).toHaveLength(2)
    expect(saves[1]).toEqual(original)
    expect(preference.revision).toBe(1)
    expect(receipts.size).toBe(1)
    expect(previews).toHaveLength(1)
    expect(window.sessionStorage.getItem(retentionCommandKey('retention-owner'))).toBeNull()
  })

  it('fails closed on a malformed recovery record and never sends it', async () => {
    const key = retentionCommandKey('retention-owner')
    window.sessionStorage.setItem(key, '{broken')
    mount()
    expect(await screen.findByText('Save recovery is unavailable.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument()
    expect(saves).toHaveLength(0)
    window.sessionStorage.removeItem(key)
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(await duration()).toHaveValue(7)
  })

  it('keeps the edit and sends nothing if the pending command cannot be stored', async () => {
    mount()
    const user = await setDuration('2')
    const originalWrite = Storage.prototype.setItem
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new Error('Storage blocked')
      originalWrite.call(this, key, value)
    })
    await save(user)
    expect(await screen.findByText('Save recovery is unavailable.')).toBeVisible()
    expect(saves).toHaveLength(0)
    write.mockRestore()
    await user.click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(await duration()).toHaveValue(2)
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled()
  })

  it('does not carry an old owner draft into a new authenticated session', async () => {
    const view = mount()
    await setDuration('2')
    view.unmount()
    beginSessionChange()
    finishSessionChange()
    preference = { ownerPrincipalId: 'second-owner', durationSeconds: 1_209_600, revision: 0 }
    mount()
    expect(await duration()).toHaveValue(14)
    expect(saves).toHaveLength(0)
  })
})
