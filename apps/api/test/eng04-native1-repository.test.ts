import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution, type PromptSettingSnapshot } from '@foreman-code/contracts'
import type pg from 'pg'
import { beforeGraphCommit, ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RepeatRunRepository, type RepeatLockedHooks } from '../src/modules/runs/repeatPostgres.js'
import { repeatDigest, repeatExecutionIdentity, repeatSlotId, freezeRepeatEntry } from '../src/modules/runs/repeatResolution.js'
import type { RepeatNativeChange } from '../src/modules/runs/repeatNativeRepository.js'
import { workflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { nativeAt, nativeCompleted, nativeFixture } from './eng04-native-fixtures.js'

/** Real repository + transaction facade over scripted, rollback-capable pg
 * replies. The authority/publication adapters here are TEST DOUBLES, not a
 * production v3 adapter, authenticated HTTP/MCP test, or PostgreSQL fixture. */
function fixture() {
  const f = nativeFixture(), entry = freezeRepeatEntry({}, [])
  const input = { executionSemanticsVersion: 3, runInput: {}, occurrence: f.occurrence, entry, predecessors: [] }
  let execution = HarnessExecutionSchema.parse({ id: f.execution.id, runId: f.scope.runId,
    workflowNodeId: f.ref.nodeId, agentId: f.execution.agentId, agentConfigurationVersionId: f.execution.agentConfigurationVersionId,
    attempt: 1, createdAt: nativeAt, state: 'queued', input })
  let launchDigest: string | undefined
  let systemPrompt: PromptSettingSnapshot = { value: { text: '' }, revision: 0, versionId: null }
  let saved: { execution: HarnessExecution; launchDigest: string | undefined } | undefined
  const state = { stopped: false, owned: true, deny: false, loseCommit: false, missingReceipt: false,
    possible: false, forgedAttempt: false, failPublication: false, consumedInside: false }
  const calls: string[] = [], changes: RepeatNativeChange[] = []
  const rows = (items: unknown[]) => ({ rows: items, rowCount: items.length })
  const client = { async query(text: string, values: unknown[] = []) {
    const q = text.replace(/\s+/g, ' ').trim(); calls.push(q)
    if (q.startsWith('begin')) { saved = { execution: structuredClone(execution), launchDigest }; return rows([]) }
    if (q === 'commit') {
      saved = undefined
      if (state.loseCommit) throw new Error('lost commit reply') // transaction may have committed; do not retry
      return rows([])
    }
    if (q === 'rollback') {
      if (saved) { execution = saved.execution; launchDigest = saved.launchDigest; saved = undefined }
      return rows([])
    }
    if (q.startsWith('select r.record as run')) return rows([{ run: {
      id: f.scope.runId, workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      workflowVersionId: f.scope.workflowVersionId, executionSemanticsVersion: 3,
      agentConfigurationVersionIds: f.version.agentConfigurationVersionIds, approval: f.version.approval,
      input: {}, executionState: 'running',
    }, version: f.version, stopped: state.stopped, state: 'running', now: nativeAt }])
    if (q.startsWith('select e.record,e.accepted')) {
      expect(q).toContain('for update of e')
      expect(values).toEqual([execution.id, execution.runId])
      return rows([{ record: structuredClone(execution), accepted: false,
        identity: { ...repeatExecutionIdentity(execution), occurrence: f.occurrence.identity },
        slot_id: repeatSlotId(f.scope.runId, f.ref), occurrence_id: f.occurrence.identity.occurrenceId,
        workflow_node_id: f.ref.nodeId, input_json: JSON.stringify(input), input_digest: repeatDigest(input),
        execution_run_id: execution.runId, execution_node_id: execution.workflowNodeId, execution_agent_id: execution.agentId,
        execution_attempt: state.forgedAttempt ? 2 : execution.attempt, technical_attempt: execution.attempt,
        execution_occurrence_id: f.occurrence.identity.occurrenceId, identity_occurrence_id: f.occurrence.identity.occurrenceId }])
    }
    if (q.startsWith('select e.record,c.record as configuration from harness_executions e')) {
      expect(values).toEqual([execution.runId, execution.workflowNodeId, execution.id])
      return rows([])
    }
    if (q.startsWith('select record,input_json,input_digest from run_repeat_occurrences')) return rows([{
      record: f.occurrence, input_json: JSON.stringify(entry), input_digest: repeatDigest(entry),
    }])
    if (q.startsWith('select payload_digest from run_repeat_effects')) return rows([{ payload_digest: repeatDigest(input) }])
    if (q.includes('from workflow_native_entries where')) {
      const reservation = workflowNativeReservation(f.scope, f.ref, execution, repeatDigest(input))
      return rows([{ reservation, reservation_digest: repeatDigest(reservation), phase: 'reserved', transition: null }])
    }
    if (q.startsWith('select effect_digest from run_graph_effects')) return rows(launchDigest ? [{ effect_digest: launchDigest }] : [])
    if (q.includes('from application_settings')) return rows([{ record: systemPrompt.value,
      revision: String(systemPrompt.revision), current_version_id: systemPrompt.versionId }])
    if (q.startsWith('select ( exists(select 1 from run_graph_effects')) return rows([{ possible_submission: state.possible }])
    if (q.startsWith('update harness_executions set record=$3::jsonb')) {
      expect(values[0]).toBe(execution.id)
      expect(values[1]).toBe(execution.runId)
      expect(JSON.parse(String(values[3]))).toEqual(execution)
      execution = HarnessExecutionSchema.parse(JSON.parse(String(values[2])))
      return rows([{ id: execution.id }])
    }
    throw new Error(`Unmodelled SQL: ${q}`)
  } } as unknown as pg.ClientBase
  const assertOwned = () => { if (!state.owned) throw new Error('owner lost') }
  const connection = new ExclusiveGraphConnection(client, assertOwned)
  const owner = { runId: f.scope.runId, assertOwned, oneShotConnection: () => connection,
    readOneShotFence: async () => { assertOwned(); return { ownerId: 'owner', fence: '17' } } }
  const host = { async openLocked(_sql: unknown, _scope: unknown, run: unknown): Promise<RepeatLockedHooks> {
    return { run: run as RepeatLockedHooks['run'],
      assertAuthorityLocked: async () => { calls.push('authority'); if (state.deny) throw new Error('authority denied') },
      assertAdmissionLocked: async () => undefined, assertSettlementLocked: async () => undefined,
      allowTechnicalRetryLocked: async () => false,
      publishLocked: async () => { throw new Error('not a launch operation') },
      assertPublicationReceiptLocked: async () => { calls.push('input-receipt') },
      completeRunLocked: async () => { throw new Error('not a completion operation') },
      native: {
        assertLaunchLocked: async () => { calls.push('launch-authority') },
        assertBoundaryLocked: async () => { calls.push('native-boundary') },
        assertUpdateLocked: async () => { throw new Error('not a native observation operation') },
        publishLocked: async (sql, change, mutate) => {
          changes.push(structuredClone(change)); calls.push('publish')
          expect(store.consumeLaunchPermit(execution.id)).toBe(false)
          state.consumedInside = true
          await mutate()
          if (state.failPublication) throw new Error('publication failed')
          beforeGraphCommit(sql, async () => {
            if (change.effect && !state.missingReceipt) launchDigest = change.effect.digest
          })
        },
        assertReceiptLocked: async () => undefined,
        assertLaunchReceiptLocked: async (sql, _claim, digest) => {
          beforeGraphCommit(sql, async () => {
            if (launchDigest !== digest) throw new Error('canonical receipt missing')
          })
        },
      },
    }
  } }
  const store = new RepeatRunRepository(owner, host, f.version)
  const channel = createWorkflowNativeCaptureChannel()
  const evidence = () => channel.capture.capture({ owner: owner as never, execution,
    session: { harness: 'codex', providerVersion: 'synthetic-only', nativeSessionId: execution.nativeSessionId! },
    manager: { harness: 'codex' } as never, source: { type: 'boundary' }, kind: 'recovery',
    lifetimeGeneration: 1, closureGeneration: null, assertCurrent: assertOwned })
  return { evidence, f, state, calls, changes, connection, store,
    setSystemPrompt: (snapshot: PromptSettingSnapshot) => { systemPrompt = structuredClone(snapshot) },
    record: () => structuredClone(execution),
    terminal: () => { execution = nativeCompleted(HarnessExecutionSchema.parse({ ...f.execution, input })) },
    recover: () => new RepeatRunRepository(owner, host, f.version),
  }
}
const paths = { workingDirectory: '/accepted/root', runtimeDirectory: '/accepted/runtime/exact' }

describe('ENG04 NATIVE-1 launch commit, denial and immutable replay', () => {
  it('pins the application system prompt at first launch and retains its revision after recovery', async () => {
    const f = fixture()
    const accepted = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    f.setSystemPrompt(accepted)
    const claimed = await f.store.claimLaunch(f.f.execution.id, paths)
    expect(claimed?.systemPrompt).toEqual(accepted)
    expect(f.record().systemPrompt).toEqual(accepted)
    f.setSystemPrompt({ value: { text: 'Changed app instructions.' }, revision: 4, versionId: 'prompt-version-4' })
    expect(await f.recover().claimLaunch(f.f.execution.id, paths)).toBeUndefined()
    expect(f.record().systemPrompt).toEqual(accepted)
    await f.connection.close()
  })
  it('issues no permit until confirmed COMMIT and consumes it exactly once', async () => {
    const f = fixture()
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    const claimed = await f.store.claimLaunch(f.f.execution.id, paths)
    expect(claimed?.state).toBe('starting')
    expect(f.state.consumedInside).toBe(true)
    expect(f.calls.at(-1)).toBe('commit')
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(true)
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    await f.connection.close()
  })
  it('replay and a fresh repository cannot mint a permit from an existing receipt', async () => {
    const f = fixture()
    await f.store.claimLaunch(f.f.execution.id, paths)
    f.store.consumeLaunchPermit(f.f.execution.id)
    expect(await f.store.claimLaunch(f.f.execution.id, paths)).toBeUndefined()
    const recovered = f.recover()
    expect(await recovered.claimLaunch(f.f.execution.id, paths)).toBeUndefined()
    expect(recovered.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    expect(f.changes).toHaveLength(1)
    await f.connection.close()
  })
  it('a lost COMMIT reply keeps possible-submission evidence but grants no permit', async () => {
    const f = fixture(); f.state.loseCommit = true
    await expect(f.store.claimLaunch(f.f.execution.id, paths)).rejects.toThrow('lost commit reply')
    expect(f.record().state).toBe('starting')
    expect(f.connection.unusable).toBe(true)
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    await f.connection.close()
  })
  it.each(['missingReceipt', 'failPublication'] as const)('%s rolls back paths/state and cannot grant a permit', async (flag) => {
    const f = fixture(); f.state[flag] = true
    await expect(f.store.claimLaunch(f.f.execution.id, paths)).rejects.toThrow()
    expect(f.record().state).toBe('queued')
    expect(f.record().runtimeDirectory).toBeUndefined()
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    await f.connection.close()
  })
  it.each(['stopped', 'deny', 'possible', 'forgedAttempt'] as const)('%s rejects before publication', async (flag) => {
    const f = fixture(); f.state[flag] = true
    await expect(f.store.claimLaunch(f.f.execution.id, paths)).rejects.toThrow()
    expect(f.changes).toHaveLength(0)
    expect(f.record().state).toBe('queued')
    expect(f.store.consumeLaunchPermit(f.f.execution.id)).toBe(false)
    await f.connection.close()
  })
  it('exact already-terminal replay after Stop has no mutation or native callback', async () => {
    const f = fixture(); f.terminal(); f.state.stopped = true
    const saved = f.record()
    await f.store.updateExecution(saved, f.evidence())
    expect(f.record()).toEqual(saved)
    expect(f.calls).not.toContain('native-update')
    expect(f.changes).toHaveLength(0)
    await f.connection.close()
  })
  it('contradictory terminal replay fails before normalization or publication', async () => {
    const f = fixture(); f.terminal()
    const saved = f.record()
    await expect(f.store.updateExecution({ ...saved, result: { outcome: 'canceled' } }, f.evidence())).rejects.toMatchObject({ code: 'REPEAT_TERMINAL_CONFLICT' })
    expect(f.record()).toEqual(saved)
    expect(f.calls).not.toContain('native-update')
    expect(f.changes).toHaveLength(0)
    await f.connection.close()
  })
})
