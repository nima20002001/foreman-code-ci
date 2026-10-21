import { describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { projectInteractionActivity, projectInteractionSummary, type InteractionActivityEvidence } from '../src/modules/interactions/activityProjection.js'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { InteractionService } from '../src/modules/interactions/service.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'

const interaction = NATIVE_INTERACTION_FIXTURES.codex
const live: InteractionActivityEvidence = { response: { authorized: true, qualified: true, usable: true, path: 'live_callback',
  identity: { interactionId: interaction.id, revision: interaction.revision, sessionId: interaction.nativeSessionId,
    requestId: interaction.nativeRequestId, executionId: interaction.executionId } } }
const owner = { kind: 'execution' as const, workspaceId: interaction.workspaceId, workflowId: interaction.workflowId,
  runId: interaction.runId, workflowVersionId: 'immutable-version', executionId: interaction.executionId, attemptKey: 'attempt-one' }

describe('authoritative interaction activity', () => {
  it('qualifies exact live callbacks separately from recorded request and delivered/worker evidence', () => {
    expect(projectInteractionActivity(interaction, live)).toMatchObject({ phase: 'needs_answer', answerRecorded: false,
      nativeDelivery: 'not_started', workerAcknowledgment: 'unknown', response: { available: true, path: 'live_callback' } })
    const lost = { ...live, response: { ...live.response, path: null, usable: false } }
    expect(projectInteractionSummary(interaction, owner, lost)).toMatchObject({ delivery: 'pending', responseAvailability: 'recovery_required',
      providerAcknowledged: false, workerAcknowledged: false })
    for (const change of [{ authorized: false }, { qualified: false }, { identity: { ...live.response.identity!, requestId: 'predecessor' } }]) {
      expect(projectInteractionActivity(interaction, { response: { ...live.response, ...change } }).response.available).toBe(false)
    }
  })

  it('does not call uncertain/submitted answers delivered, or callback completion worker acknowledgment', () => {
    const recorded: DurableInteraction = { ...interaction, status: 'decided', selectedOptionId: interaction.responseOptions[0]!.optionId,
      selectedSemantic: interaction.responseOptions[0]!.semantic, nativeResponse: {}, decidedAt: interaction.createdAt }
    expect(projectInteractionActivity(recorded, live)).toMatchObject({ phase: 'answer_recorded', answerRecorded: true, response: { available: false } })
    for (const deliveryState of ['submitted', 'uncertain'] as const) {
      const pending: DurableInteraction = { ...recorded, status: 'delivery_pending', deliveryState }
      expect(projectInteractionActivity(pending, { ...live, workerAcknowledgmentId: 'callback-return' })).toMatchObject({
        phase: deliveryState === 'uncertain' ? 'uncertain' : 'delivery_pending', workerAcknowledgment: 'unknown' })
    }
    const delivered: DurableInteraction = { ...recorded, status: 'delivered', deliveryState: 'delivered', deliveredAt: interaction.createdAt }
    expect(projectInteractionActivity(delivered, live).workerAcknowledgment).toBe('unknown')
    expect(projectInteractionActivity(delivered, { ...live, workerAcknowledgmentId: 'durable-worker-ack' }).workerAcknowledgment).toBe('confirmed')
    expect(projectInteractionActivity({ ...delivered, status: 'canceled' }, live)).toMatchObject({ phase: 'canceled', nativeDelivery: 'delivered' })
  })

  it('keeps pinned execution provenance and rejects mixing a selected newer execution', () => {
    expect(projectInteractionSummary(interaction, owner, live).owner).toEqual(owner)
    expect(() => projectInteractionSummary(interaction, { ...owner, executionId: 'latest-execution' }, live)).toThrow(/owner/)
  })
})

it('shared authenticated read projects current response authority and rejects denied actors before runtime inspection', async () => {
  const repository = Object.create(Wave25InteractionRepository.prototype) as Wave25InteractionRepository
  repository.activityAcknowledgment = vi.fn(async () => ({}))
  repository.get = vi.fn(async () => ({ ...interaction, approval: { handler: 'user' as const } }))
  const inspect = vi.fn(async () => live)
  const service = new InteractionService(repository, {} as PostgresApprovalBudgetRepository,
    {} as InteractionNativeRuntime, async () => {}, undefined, inspect)
  const principal: ManagementPrincipal = { id: 'activity-reader', name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['interactions:read'], scope: { runIds: [interaction.runId] } }] }
  expect((await service.reviewStatusVisible(principal, interaction.id)).activity.response)
    .toMatchObject({ available: false, reason: 'unauthorized' })
  const writer = { ...principal, grants: [{ actions: ['interactions:read', 'interactions:respond'] as const,
    scope: { runIds: [interaction.runId] } }] }
  expect((await service.reviewStatusVisible({ ...writer, grants: writer.grants.map((grant) => ({ ...grant, actions: [...grant.actions] })) }, interaction.id))
    .activity.response.available).toBe(true)
  const foreignWriter = { ...principal, grants: [...principal.grants,
    { actions: ['interactions:respond' as const], scope: { runIds: ['another-run'] } }] }
  expect((await service.reviewStatusVisible(foreignWriter, interaction.id)).activity.response)
    .toMatchObject({ available: false, reason: 'unauthorized' })
  inspect.mockClear()
  await expect(service.reviewStatusVisible({ ...principal, grants: [] }, interaction.id)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(inspect).not.toHaveBeenCalled()
})
