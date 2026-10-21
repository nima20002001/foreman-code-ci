import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, type AcceptedWorkflowRunV3, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../runs/ownership.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'
import { workflowMemoryDigestPrompt } from './workflowPreparation.js'
import { WorkflowCollaborationIntegration } from './workflowIntegration.js'
import { createWorkflowCollaborationHooks } from './workflowHooks.js'

describe('workflow collaboration public preparation boundaries', () => {
  it('keeps disabled memory and browser completely outside storage and host discovery', async () => {
    const saved = makeCurrentWorkflowFixture('disabled-collaboration', 'single')
    const { executionId, ...identity } = saved.identities[0]!
    const owner = { assertOwned() {}, get oneShotConnection(): never { throw new Error('Disabled features touched storage') } } as unknown as RunOwnership
    const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId,
      runId: saved.run.id, state: 'queued', input: {}, createdAt: saved.createdAt })
    const integration = new WorkflowCollaborationIntegration(undefined, async () => { throw new Error('Disabled browser discovered a host') })
    await integration.prepare(owner, saved.run as AcceptedWorkflowRunV3, saved.version, execution)
    expect(await integration.readPrompt(owner, execution, saved.version)).toBeUndefined()
    await integration.release(owner, execution, 'stop', saved.version)
  })

  it('does not read browser preparation when the accepted node disables Browser and its port is installed', async () => {
    const saved = makeCurrentWorkflowFixture('browser-disabled', 'single')
    const { executionId, ...identity } = saved.identities[0]!
    const owner = { runId: saved.run.id, assertOwned() {}, get oneShotConnection(): never { throw new Error('Disabled browser touched storage') } } as unknown as RunOwnership
    const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId,
      runId: saved.run.id, state: 'queued', input: {}, createdAt: saved.createdAt })
    const integration = new WorkflowCollaborationIntegration({ browser: {
      prepare: async () => { throw new Error('Disabled browser prepared a session') },
      release: async () => { throw new Error('Disabled browser released a session') },
    } }, async () => { throw new Error('Disabled browser discovered a computer') })
    await integration.prepare(owner, saved.run as AcceptedWorkflowRunV3, saved.version, execution)
    const read: (owner: RunOwnership, execution: ReturnType<typeof HarnessExecutionSchema.parse>, version: WorkflowVersionV3) => Promise<string | undefined>
      = integration.readPrompt.bind(integration)
    await expect(read(owner, execution, saved.version)).resolves.toBeUndefined()
    await integration.release(owner, execution, 'stop', saved.version)
  })

  it('keeps unmarked historical Runs outside the new SQL effects and projections', async () => {
    const saved = makeCurrentWorkflowFixture('historical-collaboration', 'single')
    const { executionId, ...identity } = saved.identities[0]!
    const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId,
      runId: saved.run.id, state: 'queued', input: {}, createdAt: saved.createdAt })
    const transaction = new Proxy({}, { get(): never { throw new Error('Historical Run touched a new transaction seam') } }) as GraphTransactionSql
    const hooks = createWorkflowCollaborationHooks()
    const input = { run: saved.run, version: saved.version, execution, sourceEventKey: 'old-event' }
    await hooks.lifecycleLocked(transaction, { ...input, phase: 'admitted' })
    await hooks.resultLocked(transaction, { ...input, result: { kind: 'none', reason: 'no_changes' }, summary: 'Old result' })
  })

  it('enforces digest UTF-8 bytes and card count without copying a board into work input', () => {
    const text = 'π'.repeat(6144)
    const digest = { text, byteLength: 12288, cardIds: ['card-1'], omittedCount: 2 }
    const prompt = workflowMemoryDigestPrompt(digest)!
    const saved = makeCurrentWorkflowFixture('bounded-memory', 'single')
    const { executionId, ...identity } = saved.identities[0]!
    const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId,
      runId: saved.run.id, state: 'starting', input: { task: 'Immutable input' }, createdAt: saved.createdAt,
      workingDirectory: '/work', runtimeDirectory: '/runtime' })
    const request = workflowExecutionRequest({ execution, version: saved.version, configuration: saved.configurations[0]!,
      workspaceId: saved.run.workspaceId, collaborationPrompt: prompt })
    expect(request.input).toEqual({ task: 'Immutable input' })
    expect(request.initialPrompt).toContain(text)
    expect(request.initialPrompt).toContain('2 additional items are omitted')
    expect(() => workflowMemoryDigestPrompt({ ...digest, text: `${text}π`, byteLength: 12290 })).toThrow()
    expect(() => workflowMemoryDigestPrompt({ ...digest, byteLength: text.length })).toThrow()
    expect(() => workflowMemoryDigestPrompt({ ...digest, cardIds: Array.from({ length: 21 }, (_, i) => `card-${i}`) })).toThrow()
    expect(workflowMemoryDigestPrompt({ text: '', byteLength: 0, cardIds: [], omittedCount: 0 })).toBeUndefined()
  })
})
