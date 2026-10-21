import { hydrate, type QueryClient } from '@tanstack/react-query'
import { SendAgentChatMessageRequestSchema } from '@foreman-code/contracts/agent-chat'
import { identityEpoch, protectedKey } from '../../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../../shared/api/sessionBoundary'
import type { AgentChatCommand } from './commandRecords'

const documentEpoch = identityEpoch()
const storageError = 'Pending message storage is unavailable. Recover the original message before sending again.'
type SendCommand = Extract<AgentChatCommand, { kind: 'send' }>
const prefix = (draftKey: string) => protectedKey('outbox', `agent:${draftKey}:`)

/** Persist only immutable send inputs. Query owns delivery and recovered command state. */
export function rememberPendingCommand(draftKey: string, command: SendCommand): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) throw new Error(storageError)
  const key = prefix(draftKey) + encodeURIComponent(command.input.requestId)
  const value = JSON.stringify({ input: SendAgentChatMessageRequestSchema.parse(command.input),
    clearDraft: command.clearDraft, submittedAt: Date.now() })
  window.localStorage.setItem(key, value)
  if (window.localStorage.getItem(key) !== value) throw new Error(storageError)
}

export function forgetPendingCommand(draftKey: string, requestId: string): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) return
  try {
    window.localStorage.removeItem(prefix(draftKey) + encodeURIComponent(requestId))
  } catch (error) {
    // Retaining an acknowledged input is safe; failed cleanup must not hide its receipt.
    console.warn('Acknowledged Agent message could not be removed from local storage.', error)
  }
}

/** Restore as uncertain errors, never paused writes that Query might replay. */
export function restorePendingCommands(client: QueryClient, draftKey: string, generation: number): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) return
  const mutationKey = ['agent-chat', generation, draftKey, 'command']
  const storedPrefix = prefix(draftKey)
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index)
    if (!key?.startsWith(storedPrefix)) continue
    const saved = JSON.parse(window.localStorage.getItem(key)!)
    const input = SendAgentChatMessageRequestSchema.parse(saved.input)
    if (typeof saved.clearDraft !== 'boolean' || !Number.isFinite(saved.submittedAt)
      || key !== storedPrefix + encodeURIComponent(input.requestId)) throw new Error(storageError)
    const existing = client.getMutationCache().findAll({ mutationKey, exact: true }).some((mutation) => {
      const command = mutation.state.variables as AgentChatCommand | undefined
      return command?.kind === 'send' && command.input.requestId === input.requestId
    })
    if (existing) continue
    const error = new Error('Delivery uncertain after reload. The original message may already have been accepted.')
    hydrate(client, { mutations: [{ mutationKey, state: {
      variables: { kind: 'send', input, clearDraft: saved.clearDraft }, submittedAt: saved.submittedAt,
      status: 'error', error, failureReason: error, failureCount: 1,
      isPaused: false, data: undefined, context: undefined,
    } }] })
  }
}
