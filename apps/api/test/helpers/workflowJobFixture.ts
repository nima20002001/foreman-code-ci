import { readPublicProjectionLocked } from '../../src/modules/run-graph/compactSnapshot.js'
import assert from 'node:assert/strict'
import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import type { JobWorkflowNode } from '@foreman-code/contracts/job-workflow'
import type { CurrentFixtureForm, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { openRunGraphPublication } from '../../src/modules/run-graph/publication.js'
import { publicNodeProjectionFacts, readPublicNodeProjection } from '../../src/modules/run-graph/publicProjection.js'
import { PostgresWorkflowJobNodeStore, workflowJobStorePublication } from '../../src/modules/jobs/workflowStore.js'
import type { WorkflowJobDriver, WorkflowJobLockedPort } from '../../src/modules/jobs/workflowRuntimePorts.js'
import { repeatDigest, repeatId } from '../../src/modules/runs/repeatResolution.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { buildQueueFixture } from './buildComputerFixture.js'
import { workflowSettlementFixture } from './workflowSettlementFixture.js'

/** Job transport/source and native closure are fixtures; admission, typed Job
 * persistence, acceptance, canonical publication and source binding are real. */
export async function workflowJobFixture(db: Awaited<ReturnType<typeof currentDatabase>>,
  configure: (graph: WorkflowDefinitionV3, job: JobWorkflowNode) => WorkflowDefinitionV3,
  form: CurrentFixtureForm = 'sequential') {
  let queue: Awaited<ReturnType<typeof buildQueueFixture>> | undefined
  let definition: Awaited<ReturnType<Awaited<ReturnType<typeof buildQueueFixture>>['save']>> | undefined
  let job: JobWorkflowNode | undefined
  const f = await workflowSettlementFixture(db, async (graph, writer) => {
    const settings = await writer.credential([{ actions: ['settings:update'], scope: {} }])
    queue = await buildQueueFixture(db.pool, writer.writer.principal, {
      workspaceId: writer.input.workspaceId, settingsPrincipal: settings.principal,
    })
    queue.online()
    definition = await queue.save(queue.computers[0]!.candidate.spec)
    job = { kind: 'job', id: 'build', name: 'Build', jobDefinitionId: definition.id,
      jobDefinitionRevision: definition.revision, jobDefinitionVersionId: definition.versionId }
    return configure(graph, job)
  }, form)
  assert.ok(queue && definition && job)
  const jobs = queue.jobs
  const pinnedDefinition = definition
  const node = job
  const locked: WorkflowJobLockedPort = {
    async admitPrepared(sql, ref, preparation, spec) {
      requireAuthorization(f.writer.principal, 'runs:start', {
        workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, runId: f.run.id,
      })
      const execution = await jobs.admitPrepared(sql, f.writer.principal, pinnedDefinition,
        { workflowId: f.run.workflowId, runId: f.run.id, nodeId: ref.nodeId, nodeExecutionId: preparation.executionId },
        preparation.input, spec, preparation)
      const reference = { kind: 'job', workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
        workflowVersionId: f.version.id, runId: f.run.id, nodeId: ref.nodeId,
        nodeExecutionId: execution.id, jobExecutionId: execution.id,
        occurrenceId: ref.occurrence?.occurrenceId ?? null, occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0 }
      await sql.query(`insert into workflow_job_executions
        (run_id,node_execution_id,job_execution_id,reference,input_json) values($1,$2,$2,$3::jsonb,$4)`,
      [f.run.id, execution.id, JSON.stringify(reference), JSON.stringify(preparation.input)])
      return execution
    },
    read: (sql, id) => jobs.repository.execution(sql, f.run.workspaceId, id, true),
    artifacts: async () => [],
    verifyResult: async (_sql, execution) => {
      assert.equal(execution.workflow?.runId, f.run.id)
      assert.equal(execution.process.phase, 'terminal')
      assert.equal(execution.process.processStopped, true)
      assert.equal(execution.publication, 'complete')
    },
  }
  const jobStore = () => new PostgresWorkflowJobNodeStore(f.owner, f.version, f.host, locked, workflowJobStorePublication())
  const driver: WorkflowJobDriver = {
    async prepare(preparation, signal) {
      signal.throwIfAborted()
      await f.owner.oneShotConnection().transaction(sql =>
        jobs.resolveDefinition(sql, f.writer.principal, pinnedDefinition, preparation))
      return jobs.prepareDefinition(f.owner.oneShotConnection(), f.writer.principal, pinnedDefinition, preparation)
    },
    async observe(execution, signal) {
      signal.throwIfAborted()
      await f.owner.oneShotConnection().transaction(async sql => {
        const current = await jobs.repository.execution(sql, f.run.workspaceId, execution.id, true)
        if (current.process.phase === 'terminal') return
        const next = JobExecutionRecordSchema.parse({ ...current,
          process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
          publication: 'complete', startedAt: current.createdAt, finishedAt: new Date().toISOString() })
        const publication = await openRunGraphPublication(sql, f.scope, readPublicProjectionLocked)
        const facts = publicNodeProjectionFacts(await readPublicNodeProjection(sql, f.scope, [node.id], { jobs: [next] }))
        const sourceDigest = repeatDigest(next)
        await publication.source({ evidence: { sourceKind: 'execution',
          sourceId: repeatId('fixture-job-terminal', execution.id), sourceRevision: '1' }, sourceDigest, facts },
        () => jobs.repository.putExecution(sql, next))
      })
    },
  }
  async function admitJob() {
    const ref = { nodeId: node.id, occurrence: null }
    const admission = await jobStore().prepareJob(ref)
    if (admission.kind === 'admitted') return admission.execution
    assert.equal(admission.kind, 'preparation')
    if (admission.kind !== 'preparation') throw new Error('Expected Job preparation')
    const spec = await driver.prepare(admission.preparation, new AbortController().signal)
    return jobStore().admitPreparedJob(ref, admission.preparation, spec)
  }
  return { ...f, node, jobs, definition: pinnedDefinition, jobStore, driver, admitJob,
    get owner() { return f.owner }, get store() { return f.store },
    async acceptJob() {
      const execution = await admitJob()
      await driver.observe(execution, new AbortController().signal, () => jobStore().observeJobState(
        { nodeId: node.id, occurrence: null }, execution.id))
      const resolution = await jobStore().acceptJobTerminal({ nodeId: node.id, occurrence: null }, execution.id)
      return { execution, resolution }
    },
    async close() { await jobs.closeQueue(); await f.close() },
  }
}
