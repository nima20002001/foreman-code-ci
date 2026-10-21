import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import { currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { unavailableRuntime } from './eng04-runtime-repository-fixture.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { openRepeatCanonicalPublicationLocked, publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { bindRepeatNodeInput, freezeRepeatEntry, makeRepeatOccurrence, repeatDigest, repeatExecutionIdentity,
  repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import type { RepeatEffect } from '../src/modules/runs/repeatPostgres.js'
import { agent3Database, candidateFor, graphHead, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { createRepeatFixtureWriter, insertFixtureRepeatRun, repeatReadyAgent3Fixture } from './eng04-repeat-fixture-writer.js'

// REAL PostgreSQL, migrations, owner sessions, canonical producer and receipts.
// Synthetic database setup is not authenticated Start/admission or native proof.
// No native/authority service is faked as successful: unused dependencies THROW.
// Existing helper requires explicit loopback *test* DB and isolated random schema.
describe.skipIf(!postgresEnabled)('ENG04 repository activation PostgreSQL boundary', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const owners: RunOwnership[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { for (const owner of owners) await owner.release(); await db?.close() })
  const unavailable = async (): Promise<never> => { throw new Error('No native/authority service is supplied by this read fixture') }
  const workflows = { getCurrentVersion: unavailable } as unknown as PostgresWorkflowRepository
  const locations = { revalidateRunAuthorization: unavailable } as unknown as WorkspaceLocationService
  const repository = () => new PostgresRunRepository(db.pool, workflows, locations, unavailableRuntime())
  async function own(runId: string) {
    const owner = await RunOwnership.acquire(db.pool, runId, () => undefined)
    if (!owner) throw new Error('The isolated fixture Run unexpectedly has an owner')
    owners.push(owner); return owner
  }
  async function fixture() {
    const f = repeatReadyAgent3Fixture(makeCurrentWorkflowFixture(randomUUID()))
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const fixtureWriter = await createRepeatFixtureWriter(db.pool, f)
    const saved = await fixtureWriter.publish(3)
    const { run, version, scope } = await insertFixtureRepeatRun(db.pool, f, saved, fixtureWriter.writer.principal.id)
    return { f, run, version, scope, principal: fixtureWriter.writer.principal }
  }

  /** Seed first-occurrence read data through the REAL canonical producer. There
   * is no native launch, permissive production host, or fabricated graph receipt.
   * SQL fixture setup is not the authenticated admission service under test. */
  async function canonicalFixture() {
    const t = await fixture(), owner = await own(t.run.id)
    const block = t.version.definition.repeat?.blocks[0]
    if (!block) throw new Error('The published fixture must contain its explicit repeat block')
    const occurrence = makeRepeatOccurrence(t.scope, block, freezeRepeatEntry(t.run.input, []), null)
    const ref = { nodeId: t.version.entryNodeId, occurrence: occurrence.occurrence.identity }
    const candidate = HarnessExecutionSchema.parse({ ...candidateFor(t.f), id: `execution-${randomUUID()}` })
    const bound = bindRepeatNodeInput({ version: t.version, runInput: t.run.input, recipient: candidate, ref,
      occurrence: occurrence.occurrence, entry: occurrence.input, predecessors: [] })
    expect(bound.bindings).toEqual([])
    const queued = HarnessExecutionSchema.parse({ ...candidate, input: bound.input }), slot = repeatSlotId(t.run.id, ref)
    await owner.oneShotConnection().transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked, { historyCoverage: 'from_snapshot' })
      await publishRepeatRunStateLocked(publication, owner)
      const canonical = await openRepeatCanonicalPublicationLocked(sql, t.scope, owner, publication)
      const fence = await owner.readOneShotFence(sql)
      const receipt = async (effect: RepeatEffect) => {
        await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
          values($1,$2,$3,$4,$5,$6)`, [t.run.id, effect.kind, effect.entityId, effect.digest, fence.ownerId, fence.fence])
      }
      const first: RepeatEffect = { kind: 'occurrence.create', entityId: ref.occurrence.occurrenceId, digest: repeatDigest(occurrence) }
      await canonical.publishEffectLocked(first, [{ type: 'repeat.occurrence', occurrence: occurrence.occurrence }], async () => {
        const value = occurrence.occurrence
        await sql.query(`insert into run_repeat_occurrences(occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,
          block_id,occurrence_index,binding_id,input_json,input_digest,previous_occurrence_id,previous_occurrence_index,
          previous_decision_id,previous_result_digest,record) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,null,null,null,$11::jsonb)`,
        [value.identity.occurrenceId, t.run.id, t.run.workspaceId, t.run.workflowId, t.version.id,
          value.identity.blockId, value.identity.occurrenceIndex, value.input.bindingId,
          canonicalGraphJson(occurrence.input, 4 * 1024 * 1024), value.input.inputDigest, JSON.stringify(value)])
        await receipt(first)
      })
      const admitted: RepeatEffect = { kind: 'input.bind', entityId: queued.id,
        digest: repeatDigest({ ref, queued, inputDigest: bound.digest, bindings: bound.bindings }) }
      await canonical.publishEffectLocked(admitted, [{ type: 'repeat.execution.queued', ref,
        execution: repeatExecutionIdentity(queued), inputDigest: bound.digest }], async () => {
        await sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
          values($1,$2,$3,$4,$5,$6)`, [slot, t.run.id, ref.occurrence.occurrenceId, ref.nodeId,
          canonicalGraphJson(bound.input, 4 * 1024 * 1024), bound.digest])
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
          values($1,$2,$3,$4,1,$5,$6::jsonb)`, [queued.id, t.run.id, ref.nodeId, queued.agentId, ref.occurrence.occurrenceId, JSON.stringify(queued)])
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,technical_attempt,previous_execution_id,identity)
          values($1,$2,$3,$4,1,null,$5::jsonb)`, [queued.id, t.run.id, slot, ref.occurrence.occurrenceId,
          JSON.stringify({ ...repeatExecutionIdentity(queued), occurrence: ref.occurrence })])
        await receipt(admitted)
      })
      await canonical.assertEffectReceiptLocked(first)
      await canonical.assertEffectReceiptLocked(admitted)
    })
    return { ...t, owner, queued, ref, occurrence }
  }

  it('reads the exact v3 immutable Run/version with an unavailable native capture verifier and rejects a different physical pin', async () => {
    const t = await fixture(), repo = repository()
    expect(await repo.get(t.run.id)).toEqual(t.run)
    expect(await repo.getRepeatVersion(t.run.id, t.version.id)).toEqual(t.version)
    await expect(repo.getRepeatVersion(t.run.id, t.f.version.id)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
    expect(await repo.getForWorkspace(t.run.workspaceId, t.run.id)).toEqual(t.run)
    expect(await repo.getForWorkspace('different-workspace', t.run.id)).toBeUndefined()
    expect(repo.repeatRepositoryFactory()).toBe(repo.repeatRepositoryFactory())
  })
  it('uses the owner-bound real canonical adapter and exact occurrence/input receipts for replay', async () => {
    const t = await canonicalFixture(), repo = repository(), store = await repo.repeat(t.owner)
    expect(await repo.repeat(t.owner)).toBe(store)
    expect((await store.readExecution(t.queued.id)).execution).toEqual(t.queued)
    const before = await graphHead(db.pool, t.run.id)
    expect(await repo.getExecution(t.queued.id, t.owner)).toEqual(t.queued)
    expect(await repo.ensureExecution(t.queued, t.owner)).toEqual({ execution: t.queued, created: false })
    expect((await repo.listRepeatExecutions(t.run.id, '', 10, t.owner)).map((item) => item.ref)).toEqual([t.ref])
    expect(await repo.listRepeatExecutions(t.run.id, t.queued.id, 10, t.owner)).toEqual([])
    expect(await graphHead(db.pool, t.run.id)).toBe(before)
    await expect(repo.ensureExecution({ ...t.queued, input: { changed: true } }, t.owner)).rejects.toMatchObject({ code: 'REPEAT_EXECUTION_INPUT_CONFLICT' })
    expect(repo.consumeRepeatLaunch(t.queued.id, t.owner)).toBe(false)
  })
  it('Stop rejects launch before any native/authority dependency and cannot mutate the execution', async () => {
    const t = await canonicalFixture(), repo = repository()
    await repo.requestStop(t.run.id, async (sql) => {
      const live = await currentOperatorAuthority(sql as unknown as Pick<pg.Pool, 'query'>, t.principal.id)
      requireAuthorization(live.principal, 'runs:stop', {
        workspaceId: t.run.workspaceId, workflowId: t.run.workflowId, runId: t.run.id,
      })
    })
    await expect(repo.claimRepeatLaunch(t.queued.id, { workingDirectory: db.directory,
      runtimeDirectory: '/must-not-be-allocated' }, t.owner)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect(await repo.getExecution(t.queued.id, t.owner)).toEqual(t.queued)
    expect(repo.consumeRepeatLaunch(t.queued.id, t.owner)).toBe(false)
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [t.run.id])).rowCount).toBe(0)
  })
  it('a released owner cannot consume a capability; its successor cannot inherit one from input receipts', async () => {
    const t = await canonicalFixture(), repo = repository(), first = await repo.repeat(t.owner)
    await t.owner.release()
    expect(() => repo.consumeRepeatLaunch(t.queued.id, t.owner)).toThrowError(expect.objectContaining({ code: 'RUN_OWNERSHIP_LOST' }))
    const successor = await own(t.run.id)
    expect(await repo.repeat(successor)).not.toBe(first)
    expect(repo.consumeRepeatLaunch(t.queued.id, successor)).toBe(false)
    expect(await repo.getExecution(t.queued.id, successor)).toEqual(t.queued)
  })
  it('does not route original native source through an unqualified legacy ingester or acknowledge it', async () => {
    const t = await canonicalFixture(), repo = repository()
    const event = { executionId: t.queued.id, connectionId: 'synthetic-source-generation', sequence: 7,
      type: 'synthetic.raw', occurredAt: t.run.createdAt, payload: { original: 'unmodified provider source', output: { invalid: true } } }
    const original = structuredClone(event), before = await graphHead(db.pool, t.run.id)
    for (let attempt = 0; attempt < 2; attempt++) await expect(repo.appendNativeEvent(event, t.owner))
      .rejects.toMatchObject({ code: 'NATIVE_SOURCE_NOT_CAPTURED' })
    expect((await db.pool.query('select 1 from harness_native_events where execution_id=$1', [t.queued.id])).rowCount).toBe(0)
    expect(event).toEqual(original)
    expect(await repo.getExecution(t.queued.id, t.owner)).toEqual(t.queued)
    expect(await graphHead(db.pool, t.run.id)).toBe(before)
  })
  it('a raw accepted flag without result/route/canonical acceptance receipts is not accepted v3 output', async () => {
    const t = await canonicalFixture(), repo = repository()
    const terminal = HarnessExecutionSchema.parse({ ...t.queued, state: 'completed', finishedAt: t.run.createdAt,
      result: { outcome: 'succeeded', output: { fixtureOnly: true } } })
    await db.pool.query('update harness_executions set accepted=true,record=$2::jsonb where id=$1', [terminal.id, JSON.stringify(terminal)])
    await expect(repo.getAcceptedResult(terminal.id, t.owner)).rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
  })
  it('rejects a different owner scope before writing cleanup', async () => {
    const a = await fixture(), b = await fixture(), repo = repository(), owner = await own(a.run.id)
    await expect(repo.get(b.run.id, owner)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    await expect(repo.finishCleanup(b.run.id, false, owner)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    expect((await db.pool.query('select stop_requested_at from runs where id=$1', [a.run.id])).rows[0].stop_requested_at).toBeNull()
    expect((await db.pool.query('select 1 from run_cleanup_intents where run_id=$1', [a.run.id])).rowCount).toBe(0)
  })
})
