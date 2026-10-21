import type pg from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES } from '@foreman-code/contracts'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import type { InteractionDeliveryClaim } from '../../interactions/delivery.js'
import { assertInteractionNativeDispatchLocked } from '../../interactions/wave25/delivery.js'
import type { AcceptedExecutionBinding } from '../../placement/nativeComposition.js'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { prepareRemoteOwnerControl } from './ownerControl.js'
import { admitRemoteOwnerControl } from './ownerControlAdmission.js'

vi.mock('../../interactions/wave25/delivery.js', () => ({
  assertInteractionNativeDispatchLocked: vi.fn(), assertInteractionReservedRetryLocked: vi.fn(),
}))
vi.mock('./ownerControl.js', () => ({ prepareRemoteOwnerControl: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

function fixture(generation: string, fence = '1') {
  const interaction = { ...NATIVE_INTERACTION_FIXTURES.codex, id: 'interaction', runId: 'run',
    executionId: 'execution', nativeSessionId: 'session', nativeRequestId: 'request' }
  const native = { sessionId: 'session', turnId: 'turn', processIdentityDigest: 'a'.repeat(64) }
  const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    commandId: 'response', operationId: 'operation', attemptId: 'attempt', executionId: 'execution',
    bindingHash: 'a'.repeat(64), owner: { grantId: 'grant', epoch: '1' }, native,
    action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1',
      nativeInteractionId: 'request', response: interaction.responseOptions[0] } })
  const claim: InteractionDeliveryClaim = { interaction, attempt: 1, ownerToken: 'original-delivery-owner',
    correlationId: 'original-correlation', mode: 'submit', deliveryFence: fence, approvalConnectionGeneration: generation }
  let stored: unknown = null
  let storedGeneration: unknown
  const connection = new ExclusiveGraphConnection({ query: async (text: string, values: unknown[] = []) => {
    if (text.startsWith('select remote_owner_control')) return { rows: [{ remote_owner_control: stored }], rowCount: 1 }
    if (text.startsWith('update interaction_delivery_attempts')) {
      stored = JSON.parse(values[2] as string)
      storedGeneration = values[5]
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase, () => {})
  vi.mocked(prepareRemoteOwnerControl).mockResolvedValue(command)
  const owner = { runId: 'run' } as RunOwnership
  const binding = { intent: { executionId: 'execution' } } as AcceptedExecutionBinding
  return { command, claim, stored: () => ({ command: stored, generation: storedGeneration }),
    admit: () => connection.transaction(sql => admitRemoteOwnerControl(sql, owner, binding,
      { kind: 'respond', native, nativeRequestId: 'request', option: interaction.responseOptions[0]! }, claim)) }
}

it.each(['0', '1'])('admits the original response on native generation %s', async generation => {
  const f = fixture(generation)
  expect(await f.admit()).toEqual(f.command)
  expect(f.stored()).toEqual({ command: f.command, generation })
  expect(assertInteractionNativeDispatchLocked).toHaveBeenCalledOnce()
  await expect(f.admit()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_ALREADY_ADMITTED' })
})

it.each(['-1', '01', '', '1.5'])('rejects invalid native generation %s before admission', async generation => {
  const f = fixture(generation)
  await expect(f.admit()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED' })
  expect(prepareRemoteOwnerControl).not.toHaveBeenCalled()
})

it('still rejects a zero delivery fence', async () => {
  await expect(fixture('0', '0').admit()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED' })
})
