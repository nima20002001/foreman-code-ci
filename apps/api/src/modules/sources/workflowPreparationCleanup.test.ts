import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { assertWorkflowPreparationClosed, remoteWorkflowPreparationClosed,
  type loadWorkflowPreparation } from './workflowPreparationCleanup.js'

function fixture() {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, input: {}, state: 'completed',
    result: { outcome: 'canceled' }, createdAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:01:00Z',
  })
  const entry = { phase: 'entered', reservation: { execution: repeatExecutionIdentity(execution) } }
  const sql = { query: async () => ({ rows: [entry] }) } as unknown as GraphSqlClient
  const state = {
    execution, execution_state: 'completed', stop_requested: false, cleanup_pending: false, session_bound: false, nativeSession: null,
  } as Awaited<ReturnType<typeof loadWorkflowPreparation>>
  return { sql, state, entry }
}

it('allows a durable Stop to request worker closure before Main can finish its interrupted execution', async () => {
  const f = fixture()
  f.state.execution_state = 'running'
  f.state.execution.state = 'starting'
  delete f.state.execution.result
  delete f.state.execution.finishedAt
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_ACTIVE' })
  f.state.stop_requested = true
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
})

it('accepts the persisted no-submission outcome of a stopped preparation', async () => {
  const f = fixture()
  f.entry.phase = 'not_submitted'
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
})

it.each(['running', 'bound', 'native-id', 'success', 'changed-attempt'] as const)(
  'refuses to release a workflow preparation with %s', async defect => {
    const f = fixture()
    if (defect === 'running') f.state.execution_state = 'running'
    if (defect === 'bound') f.state.session_bound = true
    if (defect === 'native-id') f.state.execution.nativeSessionId = 'native'
    if (defect === 'success') f.state.execution.result = { outcome: 'succeeded', output: {} }
    if (defect === 'changed-attempt') f.entry.reservation.execution.attempt++
    await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toBeDefined()
  },
)

it('permits closure of the same recorded native session after the Run is fenced', async () => {
  const f = fixture()
  f.state.execution.nativeSessionId = 'original-native'
  f.state.session_bound = true
  f.state.nativeSession = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'original-native' }
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
  f.state.nativeSession.nativeSessionId = 'another-native'
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_ACTIVE' })
})

it.each(['entry', 'non-entry'] as const)('releases the original preparation after positive %s closure without a session', async kind => {
  const mainId = randomUUID()
  const intent = DispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId,
    runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation', attemptId: 'attempt',
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } })
  const connection = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const launchId = randomUUID()
  const entryClosure = { intent, connection, owner: 'execution:execution', initialLaunchId: launchId,
    launches: [{ owner: 'execution:execution', launchId, bootId: connection.bootId,
      lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }] }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent, connection,
    workerIncarnationId: randomUUID(), sequence: 5, phase: 'confirmed_terminal', controls: [],
    entryAttempted: kind === 'entry', turnEntryAttempted: false, stopFence: true,
    terminal: kind === 'entry' ? { kind: 'cancelled', entryClosure,
      closureEvidenceDigest: remoteEntryClosureDigest(entryClosure) }
      : { kind: 'not_started', closureEvidenceDigest: remoteNonEntryClosureDigest(intent) } })
  const state = { sessionBound: false, current: intent }
  const sql = { query: async (text: string) => {
    if (text.includes('select i.operation_id,r.workspace_id')) {
      return { rows: [{ operation_id: intent.operationId, workspace_id: 'workspace' }] }
    }
    if (text.startsWith('select receipt,')) return { rows: [{ receipt, session_bound: state.sessionBound }] }
    if (text.startsWith('select record from execution_dispatch_intents')) return { rows: [{ record: state.current }] }
    return { rows: [] }
  } } as unknown as GraphSqlClient
  await expect(remoteWorkflowPreparationClosed(sql, 'execution')).resolves.toBe(true)
  state.sessionBound = true
  await expect(remoteWorkflowPreparationClosed(sql, 'execution')).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_NOT_FOUND' })
  state.sessionBound = false
  state.current = { ...intent, attemptId: 'another-attempt' }
  await expect(remoteWorkflowPreparationClosed(sql, 'execution')).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_NOT_FOUND' })
})
