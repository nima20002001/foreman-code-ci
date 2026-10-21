import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import type pg from 'pg'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { assertApprovalTerminalSettlement } from '../src/modules/interactions/wave25/resume.js'
import { beforeGraphCommit, ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RepeatRunRepository, type RepeatLockedHooks } from '../src/modules/runs/repeatPostgres.js'
import { repeatDigest, repeatExecutionIdentity, repeatSlotId, freezeRepeatEntry } from '../src/modules/runs/repeatResolution.js'
import { repeatLaunchClaim, type RepeatNativeChange, type RepeatNativeEvidence } from '../src/modules/runs/repeatNativeRepository.js'
import { createWorkflowNativeCaptureChannel, type WorkflowNativeCaptureInput } from '../src/modules/interactions/workflowNativeCapture.js'
import { workflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'
import { nativeAt, nativeCompleted, nativeFixture } from './eng04-native-fixtures.js'

// Exact approval/native acknowledgement is an explicit TEST DOUBLE here. The
// integrated PostgreSQL/provider gate must exercise the real approval service.
vi.mock('../src/modules/interactions/wave25/resume.js', () => ({ assertApprovalTerminalSettlement: vi.fn(async () => undefined) }))
beforeEach(() => vi.mocked(assertApprovalTerminalSettlement).mockClear())

/** Real repository + transaction facade over scripted, rollback-capable pg
 * replies. The authority/publication adapters here are TEST DOUBLES, not a
 * production v3 adapter, authenticated HTTP/MCP test, or PostgreSQL fixture. */
function fixture() {
  const channel = createWorkflowNativeCaptureChannel()
  const f = nativeFixture(), entry = freezeRepeatEntry({}, [])
  const configuration = AgentConfigurationVersionSchema.parse({ ...makeCurrentWorkflowFixture('repository-activation-config').configurations[0],
    id: f.execution.agentConfigurationVersionId, agentId: f.execution.agentId, workspaceId: f.scope.workspaceId })
  const session = { harness: configuration.harness.harness, providerVersion: 'synthetic-no-native-call', nativeSessionId: f.execution.nativeSessionId! }
  const input = { executionSemanticsVersion: 3, runInput: {}, occurrence: f.occurrence, entry, predecessors: [] }
  let execution = HarnessExecutionSchema.parse({ id: f.execution.id, runId: f.scope.runId,
    workflowNodeId: f.ref.nodeId, agentId: f.execution.agentId, agentConfigurationVersionId: f.execution.agentConfigurationVersionId,
    attempt: 1, createdAt: nativeAt, state: 'queued', input })
  let launchDigest: string | undefined
  let saved: { execution: HarnessExecution; launchDigest: string | undefined } | undefined
  const state = { stopped: false, owned: true, deny: false, loseCommit: false, missingReceipt: false,
    possible: false, forgedAttempt: false, failPublication: false, consumedInside: false,
    corruptGuard: false, loseOwnerAtFinalize: false, missingSession: false, missingReservation: false }
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
    if (q.startsWith('select e.record,c.record as configuration from harness_executions e')) return rows([])
    if (q.startsWith('select record,input_json,input_digest from run_repeat_occurrences')) return rows([{
      record: f.occurrence, input_json: JSON.stringify(entry), input_digest: repeatDigest(entry),
    }])
    if (q.startsWith('select payload_digest from run_repeat_effects')) return rows([{ payload_digest: repeatDigest(input) }])
    if (q.startsWith('select reference from execution_native_sessions')) return rows(state.missingSession ? [] : [{ reference: session }])
    if (q.startsWith('select c.record,s.reference from agent_configuration_versions')) {
      expect(values).toEqual([execution.id, configuration.id, configuration.agentId, configuration.workspaceId])
      return rows(state.missingSession ? [] : [{ record: configuration, reference: session }])
    }
    if (q.startsWith('select id,agent_id,workspace_id,record from agent_configuration_versions')) return rows([{
      id: configuration.id, agent_id: configuration.agentId, workspace_id: configuration.workspaceId, record: configuration,
    }])
    if (q.startsWith('select phase,reservation,reservation_digest,transition')) {
      const reservation = workflowNativeReservation(f.scope, f.ref, execution, repeatDigest(input))
      return rows(state.missingReservation ? [] : [{ phase: 'reserved', reservation,
        reservation_digest: repeatDigest(reservation), transition: null, source_id: null, source_digest: null }])
    }
    if (q.startsWith('select effect_digest from run_graph_effects')) return rows(launchDigest ? [{ effect_digest: launchDigest }] : [])
    if (q.includes('from application_settings')) return rows([])
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
        assertUpdateLocked: async (_sql, _previous, incoming, _ref, evidence) => {
          calls.push('native-update')
          // Explicit recording-adapter result; this is not native capture evidence.
          const recorded = { proofId: 'recording-proof', scope: f.scope, ref: f.ref,
            execution: repeatExecutionIdentity(incoming), inputDigest: repeatDigest(input), commandId: 'recording-command',
            session, original: channel.verify.read(evidence).source, observedAt: nativeAt,
            ownerId: 'owner', ownerFence: '17', lifetimeGeneration: 1, closureGeneration: 'recording-close', lane: null }

          if (state.corruptGuard) {
            incoming.result = { outcome: 'canceled' }
            expect(() => { evidence.evidence = { rewritten: true } }).toThrow()
          }
          return recorded
        },
        publishLocked: async (sql, change, mutate) => {
          changes.push(structuredClone(change)); calls.push('publish')
          expect(store.consumeLaunchPermit(execution.id)).toBe(false)
          state.consumedInside = true
          await mutate()
          if (state.failPublication) throw new Error('publication failed')
          beforeGraphCommit(sql, async () => {
            if (state.loseOwnerAtFinalize) state.owned = false
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
  return { f, state, calls, changes, connection, store, session,
    // Private unit-test channel: never accepted by a production capture verifier.
    proof: (terminal = nativeCompleted(execution)): RepeatNativeEvidence => {
      const lease = { fence: { id: 'recording-lane', token: 'recording-token' },
        previous: { connectionGeneration: 1 }, providerId: 'recording-turn' }
      return channel.capture.capture({ owner, execution, session, lease,
        manager: { harness: session.harness, assertCapturedLease(actual: unknown, captured: unknown) {
          expect(actual).toEqual(session); expect(captured).toBe(lease)
        } }, lifetimeGeneration: 1, closureGeneration: null, kind: 'live', assertCurrent: assertOwned,
        source: { type: 'history', history: { events: [], pendingInteractions: [], responseDeliveries: [],
          correlationId: `execution:${execution.id}`, nativeTurnId: lease.providerId,
          terminalTurn: { correlationId: `execution:${execution.id}`, providerId: lease.providerId, result: terminal.result } } },
      } as unknown as WorkflowNativeCaptureInput)
    },
    attach: () => { execution = HarnessExecutionSchema.parse({ ...execution, state: 'running', nativeSessionId: session.nativeSessionId }) },
    restoreClaimReceipt: () => { launchDigest = repeatDigest(repeatLaunchClaim(f.scope, f.ref, execution, repeatDigest(input))) },
    record: () => structuredClone(execution),
    terminal: () => { execution = nativeCompleted(HarnessExecutionSchema.parse({ ...f.execution, input })) },
    recover: () => new RepeatRunRepository(owner, host, f.version),
  }
}
const paths = { workingDirectory: '/accepted/root', runtimeDirectory: '/accepted/runtime/exact' }

describe('ENG04 repository activation terminal preparation and owner lifetime', () => {
  it('prepares immutable identity before a native adapter can write raw evidence', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.attach()
    const original = t.record()
    await expect(t.store.updateExecution({ ...nativeCompleted(original), input: { changed: true } }, t.proof())).rejects.toThrow()
    expect(t.calls).not.toContain('native-update')
    expect(t.record()).toEqual(original)
    await t.connection.close()
  })
  it('preserves the original failed-contract success while publishing the prepared failure, despite callback alias mutation', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.attach()
    const incoming = nativeCompleted(t.record(), { prose: 'invalid exit contract; preserve this original source' })
    const original = structuredClone(incoming), proof = t.proof(incoming), originalProof = structuredClone(proof)
    t.state.corruptGuard = true
    await t.store.updateExecution(incoming, proof)
    expect(t.record().result).toMatchObject({ outcome: 'failed', error: { code: 'REPEAT_RESULT_INVALID' } })
    expect(incoming).toEqual(original); expect(proof).toEqual(originalProof)
    const change = t.changes.at(-1)!
    expect(change.kind).toBe('observation')
    expect(change.source).toMatchObject({ incoming: original, native: { original: { type: 'history', history: { terminalTurn: { result: original.result } } } }, next: t.record() })
    expect(t.calls.indexOf('native-update')).toBeLessThan(t.calls.lastIndexOf('publish'))
    expect(assertApprovalTerminalSettlement).toHaveBeenCalledTimes(1)
    await t.connection.close()
  })
  it('rejects missing proof for a live write without calling the native adapter', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.attach()
    await expect(t.store.updateExecution(nativeCompleted(t.record()))).rejects.toMatchObject({ code: 'REPEAT_NATIVE_EVIDENCE_REQUIRED' })
    expect(t.calls).not.toContain('native-update')
    expect(t.record().state).toBe('running')
    await t.connection.close()
  })
  it('exact terminal replay after Stop needs no new live proof and changes no raw/native state', async () => {
    const t = fixture(); t.terminal(); t.state.stopped = true
    const original = t.record()
    await t.store.updateExecution(original)
    expect(t.record()).toEqual(original)
    expect(t.calls).not.toContain('native-update'); expect(t.changes).toHaveLength(0)
    expect(assertApprovalTerminalSettlement).not.toHaveBeenCalled()
    await expect(t.store.updateExecution({ ...original, result: { outcome: 'canceled' } })).rejects.toMatchObject({ code: 'REPEAT_TERMINAL_CONFLICT' })
    await t.connection.close()
  })
  it('Stop blocks a first terminal write rather than letting raw legacy update win', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.attach(); t.state.stopped = true
    const before = t.record()
    await expect(t.store.updateExecution(nativeCompleted(before), t.proof())).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect(t.calls).not.toContain('native-update'); expect(t.record()).toEqual(before)
    await t.connection.close()
  })
  it('a missing native entry reservation cannot claim a first launch', async () => {
    const t = fixture(); t.state.missingReservation = true
    await expect(t.store.claimLaunch(t.f.execution.id, paths)).rejects.toMatchObject({ code: 'NATIVE_ENTRY_CONFLICT' })
    expect(t.record().state).toBe('queued'); expect(t.changes).toHaveLength(0)
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false)
  })
  it('the original canonical claim commits before a one-use permit exists; replay cannot reconstruct it', async () => {
    const t = fixture()
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false)
    await t.store.claimLaunch(t.f.execution.id, paths)
    expect(t.calls.at(-1)).toBe('commit'); expect(t.state.consumedInside).toBe(true)
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(true)
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false)
    expect(await t.recover().claimLaunch(t.f.execution.id, paths)).toBeUndefined()
    expect(t.changes).toHaveLength(1)
    await t.connection.close()
  })
  it('COMMIT ambiguity retains possible submission but cannot return a launch capability', async () => {
    const t = fixture(); t.state.loseCommit = true
    await expect(t.store.claimLaunch(t.f.execution.id, paths)).rejects.toThrow('lost commit reply')
    expect(t.record().state).toBe('starting'); expect(t.connection.unusable).toBe(true)
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false)
    await expect(t.store.claimLaunch(t.f.execution.id, paths)).rejects.toThrow()
    expect(t.changes).toHaveLength(1)
    await t.connection.close()
  })
  it.each(['missingReceipt', 'failPublication', 'loseOwnerAtFinalize'] as const)('%s prevents claim COMMIT and never grants a permit', async (flag) => {
    const t = fixture(); t.state[flag] = true
    await expect(t.store.claimLaunch(t.f.execution.id, paths)).rejects.toThrow()
    expect(t.record().state).toBe('queued')
    if (t.state.owned) expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false)
    else expect(() => t.store.consumeLaunchPermit(t.f.execution.id)).toThrow('owner lost')
    await t.connection.close()
  })
  it('session recovery rechecks live authority before repairing a durable session binding', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.state.deny = true
    await expect(t.store.recoverSession(t.f.execution.id)).rejects.toThrow('authority denied')
    expect(t.record().nativeSessionId).toBeUndefined(); expect(t.changes).toHaveLength(1)
    await t.connection.close()
  })
  it('missing durable session is uncertainty, not permission to create or mint another launch', async () => {
    const t = fixture()
    await t.store.claimLaunch(t.f.execution.id, paths); t.store.consumeLaunchPermit(t.f.execution.id); t.state.missingSession = true
    expect((await t.store.recoverSession(t.f.execution.id)).nativeSessionId).toBeUndefined()
    expect(t.store.consumeLaunchPermit(t.f.execution.id)).toBe(false); expect(t.changes).toHaveLength(1)
    await t.connection.close()
  })
})
