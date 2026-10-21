import { useEffect } from 'react'
import { create } from 'zustand'
import { z } from 'zod'
import { FileRetentionSaveInputSchema } from '@foreman-code/contracts/files'
import { ApiError } from '../../shared/api/client'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { retentionSeconds } from './retentionDraft'

const CommandSchema = z.object({
  input: FileRetentionSaveInputSchema,
  draft: z.object({ amount: z.string(), unit: z.enum(['hours', 'days']), applyToExisting: z.boolean() }).strict(),
}).strict().refine(({ input, draft }) => retentionSeconds(draft) === input.durationSeconds
  && draft.applyToExisting === (input.applyToExisting ?? false), 'Command and draft must match')
export type RetentionCommand = z.infer<typeof CommandSchema>
interface Entry { pending?: RetentionCommand; error?: string }
const useCommands = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }))

/** Only an outstanding local command is persisted, never a cached server preference.
 * Outbox keys rotate when the app installation changes. sessionStorage isolates browser tabs. */
export const retentionCommandKey = (ownerPrincipalId: string) => protectedKey('outbox', `file-retention:${ownerPrincipalId}`)
function update(key: string, entry: Entry) {
  useCommands.setState((state) => ({ entries: { ...state.entries, [key]: entry } }))
}
function stored(key: string): RetentionCommand | undefined {
  const text = window.sessionStorage.getItem(key)
  return text === null ? undefined : CommandSchema.parse(JSON.parse(text))
}
function load(key: string) {
  try { update(key, { pending: stored(key) }) } catch { update(key, { error: 'Save recovery is unavailable.' }) }
}
export function pendingRetentionCommand(key: string): RetentionCommand | undefined {
  return useCommands.getState().entries[key]?.pending
}
export function retainRetentionCommand(key: string, command: RetentionCommand) {
  try {
    const input = CommandSchema.parse(command)
    const pending = stored(key)
    if (pending && JSON.stringify(pending.input) !== JSON.stringify(input.input)) {
      update(key, { pending })
      throw new ApiError({ code: 'RETENTION_COMMAND_UNRESOLVED', message: 'Resolve the previous save first.' })
    }
    // Write before POST: a reload during the request must reuse this exact command.
    if (!pending) window.sessionStorage.setItem(key, JSON.stringify(input))
    update(key, { pending: pending ?? input })
    return Boolean(pending)
  } catch (error) {
    if (ApiError.is(error)) throw error
    update(key, { error: 'Save recovery is unavailable.' })
    // No HTTP request was made; this local failure is definitive.
    throw new ApiError({ code: 'INVALID_REQUEST', message: 'Save recovery is unavailable.' }, undefined, { cause: error })
  }
}
export function settleRetentionCommand(key: string, commandId: string) {
  const pending = stored(key)
  if (pending && pending.input.commandId !== commandId) throw new Error('A different retention command is pending')
  window.sessionStorage.removeItem(key)
  update(key, {})
}

export function useRetentionCommand(ownerPrincipalId: string | undefined) {
  const key = ownerPrincipalId ? retentionCommandKey(ownerPrincipalId) : undefined
  const entry = useCommands((state) => key ? state.entries[key] : undefined)
  useEffect(() => { if (key && !entry) load(key) }, [key, entry])
  return { key, ready: Boolean(entry), pending: entry?.pending, error: entry?.error,
    reload: () => { if (key) load(key) } }
}

/** Drops document memory only; used to exercise real hard-reload recovery in tests. */
export function clearRetentionCommandMemory() { useCommands.setState({ entries: {} }) }
