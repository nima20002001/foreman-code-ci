import { createFixtureDatabase, dropFixtureDatabase } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { RemoteJobDispatchIntentSchema, RemoteJobOperationReceiptSchema } from '@foreman-code/contracts/remote-job-execution'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { PostgresWorkflowJobNodeStore } from '../src/modules/jobs/workflowStore.js'
import { createWorkflowJobComposition } from '../src/modules/jobs/workflowComposition.js'
import { JobRepository } from '../src/modules/jobs/repository.js'
import type { JobService } from '../src/modules/jobs/service.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointOwnerMigration } from '../src/infrastructure/checkpointOwnerMigration.js'
import { readAcceptedRepeatRunLocked } from '../src/modules/runs/repeatStartRead.js'
import type { RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { assertGraphTransaction } from '../src/modules/run-graph/connection.js'
import { repeatDigest, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { jobExecution } from './helpers/jobFixture.js'
import { deferred } from './helpers/deferred.js'

// A task-owned database with only the rows needed by the actual lock/read paths.
// This proves PostgreSQL ordering, not application migration or native execution.
describe.skipIf(process.env.JOB_LIFECYCLE_POSTGRES !== '1' && !process.env.TEST_DATABASE_URL)('Run/Job production lock order', () => {
  it('polling and trusted receipt ingestion complete on independent owner sessions', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Job lifecycle tests require loopback PostgreSQL')
    const admin = new pg.Client({ connectionString: url.toString() })
    const name = `job_lifecycle_test_${randomUUID().replaceAll('-', '')}`
    let pool: pg.Pool | undefined, runOwner: RunOwnership | undefined, dispatch: PostgresJobDispatch | undefined
    let created = false
    await admin.connect()
    try {
      await createFixtureDatabase(admin, name); created = true
      url.pathname = `/${name}`
      pool = new pg.Pool({ connectionString: url.toString(),
        options: '-c statement_timeout=5000 -c lock_timeout=4000' })
      await pool.query(`
        create table runs(id text primary key,workspace_id text,workflow_id text,workflow_version_id text,record jsonb,execution_state text,runner_id text,working_directory text,location_revision int,stop_requested_at timestamptz);
        create table workflow_versions(id text primary key,workspace_id text,workflow_id text,version int,entry_node_id text,execution_semantics_version int,record jsonb);
        create table agent_configuration_versions(id text,workspace_id text,agent_id text,version int,record jsonb);
        create table run_cleanup_intents(run_id text,pending boolean);
        create table job_executions(id text primary key,workspace_id text,record jsonb,accepted_spec jsonb,accepted_by text);
        create table job_dispatch_intents(execution_id text primary key,intent jsonb,owner_id text,owner_fence text,receipt_sequence bigint default 0,last_receipt jsonb,cancel_cleanup jsonb,cancel_command_id text,cancel_principal_id text,cancel_action text);
        create table management_principals(id text primary key,name text,audience text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
        create table run_repeat_slots(slot_id text primary key,input_digest text,input_json text);
        create table run_repeat_executions(execution_id text,run_id text,slot_id text,technical_attempt int,identity jsonb);
      `)
      await pool.query(checkpointOwnerMigration.sql)
      const base = makeCurrentWorkflowFixture(randomUUID()), execution = jobExecution()
      const node = { kind: 'job' as const, id: 'build', name: 'Build', jobDefinitionId: execution.acceptedSpec.definitionId,
        jobDefinitionRevision: 1, jobDefinitionVersionId: execution.acceptedSpec.definitionVersionId }
      const parsed = WorkflowVersionV3Schema.parse(JSON.parse(JSON.stringify({ ...base.version, agentConfigurationVersionIds: {}, entryNodeId: node.id,
        definition: { ...base.version.definition, requiredAgentCount: 0, entryNodeId: node.id, nodes: [node], edges: [], repeat: undefined, handoffs: undefined } })))
      const version = { ...parsed, contentHash: `sha256:${createHash('sha256').update(canonicalGraphJson({
        definition: parsed.definition, configurations: parsed.agentConfigurationVersionIds, entryNodeId: parsed.entryNodeId })).digest('hex')}` }
      const run = { ...base.run, workflowVersionId: version.id, agentConfigurationVersionIds: {}, executionState: 'running' as const,
        authorizationPrincipalId: 'actor', executionLocation: { runnerId: 'local', rootPath: '/test', locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } }
      execution.workspaceId = run.workspaceId
      execution.workflow = { runId: run.id, workflowId: run.workflowId, nodeId: node.id, nodeExecutionId: execution.id }
      execution.acceptedSpec.workflowInput = { executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [] }
      Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, execution.acceptedSpec.workflowInput))
      const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
        executionId: execution.id, operationId: execution.operationId, attemptId: execution.attemptId, owner: execution.owner,
        bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`,
        subject: { kind: 'workflow-node', workspaceId: execution.workspaceId, ...execution.workflow } })
      const receipt = RemoteJobOperationReceiptSchema.parse({ schemaVersion: 1, kind: 'job', intent, execution,
        connection: { kind: 'main', mainId: intent.mainId, mainInstallationId: execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() },
        workerIncarnationId: randomUUID(), sequence: 1, observedAt: new Date().toISOString(), phase: 'received',
        entryAttempted: false, stopFence: false, controls: [], publication: 'pending' })
      await pool.query('insert into workflow_versions values($1,$2,$3,$4,$5,3,$6)', [version.id, version.workspaceId, version.workflowId, version.version, node.id, JSON.stringify(version)])
      await pool.query('insert into runs values($1,$2,$3,$4,$5,$6,$7,$8,1,null)', [run.id, run.workspaceId, run.workflowId, version.id, JSON.stringify(run), run.executionState, 'local', '/test'])
      await pool.query('insert into job_executions values($1,$2,$3,$4,$5)', [execution.id, execution.workspaceId, JSON.stringify(execution), JSON.stringify(execution.acceptedSpec), 'actor'])
      await pool.query('insert into management_principals values($1,$2,$3,$4,$5,null,null)', ['actor', 'Fixture actor', 'operator',
        JSON.stringify([{ actions: ['runs:start'], scope: { workspaceIds: [run.workspaceId] } }]), new Date(Date.now() + 60000)])
      await pool.query('insert into job_dispatch_intents(execution_id,intent) values($1,$2)', [execution.id, JSON.stringify(intent)])
      const ref = { nodeId: node.id, occurrence: null }, slot = repeatSlotId(run.id, ref)
      await pool.query('insert into run_repeat_slots values($1,$2,$3)', [slot, repeatDigest(execution.acceptedSpec.workflowInput, 4 * 1024 * 1024), JSON.stringify(execution.acceptedSpec.workflowInput)])
      await pool.query('insert into run_repeat_executions values($1,$2,$3,1,$4)', [execution.id, run.id, slot,
        JSON.stringify({ kind: 'job', workflowNodeId: node.id, executionId: execution.id, jobDefinitionId: node.jobDefinitionId, jobDefinitionVersionId: node.jobDefinitionVersionId, attempt: 1 })])
      const jobOwner = await JobOwnership.acquire(pool, execution.id, () => {})
      if (!jobOwner) throw new Error('Missing Job owner')
      dispatch = new PostgresJobDispatch(pool, { deliver: vi.fn(), reconcile: vi.fn(), control: vi.fn() }, {
        revalidate: async () => {}, authorizeControl: async () => {},
        observe: async (sql, current, observed) => {
          assertGraphTransaction(sql)
          await readAcceptedRepeatRunLocked(sql, run.id) // Same Run reader as jobs/production.ts.
          await projectJobReceiptLocked(sql, current, observed, { verifyRequiredOutputs: async () => {} })
        },
      })
      Reflect.get(dispatch, 'owners').set(execution.id, { owner: jobOwner, abort: new AbortController() })
      await jobOwner.connection.transaction(async sql => {
        const fence = await jobOwner.readFence(sql)
        await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1', [execution.id, fence.ownerId, fence.fence])
      })
      runOwner = await RunOwnership.acquire(pool, run.id, () => {})
      if (!runOwner) throw new Error('Missing Run owner')
      expect(runOwner.checkpointGeneration).toBe('1')
      const competingOwner = await RunOwnership.acquire(pool, run.id, () => {})
      try {
        expect(competingOwner).toBeUndefined()
      } finally {
        await competingOwner?.release()
      }
      const runLocked = deferred(), readJob = deferred(), jobRequested = deferred()
      const repository = new JobRepository()
      const composition = createWorkflowJobComposition({ jobs: { repository } as JobService, dispatch,
        outputs: { listCanonicalOutputs: async () => [], verifyRequiredOutputs: async () => {} } }).forOwner(runOwner, version)
      const locked = { ...composition.locked, read: async (...args: Parameters<typeof composition.locked.read>) => {
        jobRequested.resolve(); return composition.locked.read(...args)
      } }
      const host = { openLocked: async () => {
        runLocked.resolve(); await readJob.promise
        return { run, assertAuthorityLocked: async () => {} }
      } } as unknown as RepeatRepositoryHost
      const store = new PostgresWorkflowJobNodeStore(runOwner, version, host, locked,
        { effect: vi.fn(), assertReceipt: vi.fn(), observe: async () => {} })
      const poll = store.observeJobState(ref, execution.id)
      await runLocked.promise
      // The dispatch query wrapper is only a barrier. All SQL reaches PostgreSQL.
      const originalQuery = jobOwner.connection.transaction.bind(jobOwner.connection)
      vi.spyOn(jobOwner.connection, 'transaction').mockImplementation(work => originalQuery(async sql => {
        const query = sql.query.bind(sql)
        sql.query = (async (text: string, values?: unknown[]) => {
          if (text.includes('from runs') && text.includes('for share')) {
            readJob.resolve(); await jobRequested.promise
          }
          return query(text, values)
        }) as typeof sql.query
        return work(sql)
      }))
      const ingestion = dispatch.observeReceipt(execution.workspaceId, execution.id, receipt)
      const results = await Promise.allSettled([poll, ingestion])
      expect(results.map(result => result.status === 'rejected' ? (result.reason as Error).message : result.status)).toEqual(['fulfilled', 'fulfilled'])
      expect((await pool.query('select receipt_sequence::text from job_dispatch_intents where execution_id=$1', [execution.id])).rows[0].receipt_sequence).toBe('1')
    } finally {
      vi.restoreAllMocks(); await runOwner?.release(); await dispatch?.close(); await pool?.end()
      try { if (created) await dropFixtureDatabase(admin, name) } finally { await admin.end() }
    }
  }, 15000)
})
