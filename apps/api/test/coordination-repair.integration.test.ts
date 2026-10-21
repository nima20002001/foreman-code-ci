import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, memoryBoardTools } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { correctiveNativeManager, type CorrectiveRequest } from './helpers/correctiveNativeManager.js'
import { memoryCall, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled).each(['corrected', 'exhausted', 'board_rejected', 'board_exhausted'] as const)(
  'repairs a production coordination result in the same native session (%s)', async mode => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    fixture.version.approval = { handler: 'native' }
    fixture.version.definition.approval = fixture.version.approval
    fixture.run.approval = fixture.version.approval
    fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
    fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call',
      reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard',
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
    const repairs: CorrectiveRequest[] = []
    let boardId: string
    const invalid = () => ({ text: JSON.stringify({ data: { text: 'Original deliverable' }, summary: 'Task finished.',
      ...(mode.startsWith('board_') ? { board: { kind: 'changes', operations: [
        { kind: 'note_create', boardId, text: 'This partial change must roll back' },
        { kind: 'card_update', boardId, cardId: 'missing-card', patch: { body: 'Invalid target' } },
      ] } } : {}),
    }) })
    const corrected = { text: JSON.stringify({ data: { text: 'Original deliverable' }, summary: 'Task finished.',
      board: { kind: 'none', reason: 'no_changes' } }) }
    const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
      outputFor: invalid,
      managerFactory: () => correctiveNativeManager(runtime.provider.connection(), repairs,
        () => ({ outcome: 'succeeded', output: mode.endsWith('exhausted') ? invalid() : corrected })),
    })
    try {
      const prepared = await prepareCoordinationWorkflow(runtime)
      boardId = prepared.boardId
      const started = await prepared.start()
      expect(started.run.resultProtocol).toBe('f1-f4-v1')
      await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.executionState).toBe('completed'),
        { timeout: 30000, interval: 50 })
      const details = await runtime.runs.getDetails(prepared.scope.workspaceId, started.run.id)
      expect(repairs).toHaveLength(mode.endsWith('exhausted') ? 2 : 1)
      expect(new Set(repairs.map(request => request.sessionId)).size).toBe(1)
      expect(runtime.provider.counts.sessions).toBe(1)
      expect(runtime.provider.startedExecutions).toHaveLength(1)
      expect(details?.executions).toHaveLength(1)
      for (const repair of repairs) expect(repair.prompt).toMatch(/Do not repeat|do not repeat/)
      if (mode.endsWith('exhausted')) {
        expect(details?.run.outcome).toBe('failed')
        expect(details?.executions[0]?.result).toMatchObject({ outcome: 'failed', error: { retryable: false } })
      } else {
        expect(details?.run.outcome).toBe('succeeded')
        expect(details?.executions[0]?.result).toEqual({ outcome: 'succeeded', output: corrected })
      }
      const notes = await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'notes' })
      expect(notes.items).toEqual([])
    } finally { await runtime.close() }
  }, 60000)
