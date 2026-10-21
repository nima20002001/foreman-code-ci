import { execFileSync } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema } from '@foreman-code/contracts/wave25'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const db = await agent3Database()
  const env = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: db.directory, env, encoding: 'utf8' })
  try {
    git('init', '-b', 'main')
    await writeFile(join(db.directory, 'project.txt'), 'project\n')
    git('add', 'project.txt')
    git('commit', '-m', 'Project')
    const trees = new RunWorktrees(db.pool, join(db.directory, 'managed'), systemGitWorktreePorts(env))
    const f = await routedApprovalFixture({ database: db, sandbox: 'workspace-write',
      preparePlacementExecution: async (_owner, run, execution) => {
        const tree = (await trees.prepare(run, AbortSignal.timeout(30_000), execution.id))!
        return { workingDirectory: tree.workingDirectory,
          runtimeDirectory: repeatRuntimeDirectory(db.directory, { workspaceId: run.workspaceId,
            workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id,
            executionSemanticsVersion: 3 }, execution), revalidate: () => trees.verify(tree) }
      } })
    return { ...f, trees,
      async close() { try { await f.close() } finally { await db.close() } },
      async incoming() {
        const execution = HarnessExecutionSchema.parse({ id: `${f.reviewer.id}-next`, runId: f.reviewer.runId,
          workflowNodeId: f.reviewer.workflowNodeId, agentId: f.reviewer.agentId,
          agentConfigurationVersionId: f.reviewer.agentConfigurationVersionId,
          attempt: f.reviewer.attempt + 1, state: 'queued', input: {}, createdAt: new Date().toISOString() })
        await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
          values($1,$2,$3,$4,$5,$6::jsonb)`, [execution.id, execution.runId, execution.workflowNodeId,
          execution.agentId, execution.attempt, JSON.stringify(execution)])
        return execution
      },
      async failReview() {
        await f.coordination.claimReviewJob(f.job.id, 'review-worker', 'review-token',
          new Date(Date.now() + 60_000).toISOString())
        const failed = await f.coordination.transitionReviewJob(f.job.id, 'review-token', 'failed', {
          retryAfter: new Date(Date.now() + 60_000).toISOString(),
          error: { code: 'REVIEW_INTERRUPTED', message: 'The reviewer needs cleanup.' },
        })
        expect(failed.cleanup).toMatchObject({ nativeState: 'pending', credentialState: 'pending' })
      },
    }
  } catch (error) {
    await db.close()
    throw error
  }
}

describe.runIf(postgresEnabled)('Reviewer checkout ownership', () => {
  it('allows serialized reviewer attachment when another checkout owner only has a queued review', async () => {
    const f = await fixture()
    try {
      const incoming = await f.incoming()
      const completed = HarnessExecutionSchema.parse({ ...incoming, state: 'completed',
        workingDirectory: f.reviewer.workingDirectory, nativeSessionId: f.reviewer.nativeSessionId,
        result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
      // Two finished turns can share a checkout and a session before their review jobs are dispatched.
      await f.db.pool.query('update harness_executions set record=$2::jsonb where id=$1',
        [completed.id, JSON.stringify(completed)])
      await f.db.pool.query(`insert into execution_native_sessions(execution_id,reference,workflow_finalized_at)
        select $1,reference,workflow_finalized_at from execution_native_sessions where execution_id=$2`,
      [completed.id, f.reviewer.id])
      await f.db.pool.query(`insert into run_worktrees(run_id,allocation_id,repository_root,checkout_root,record)
        select run_id,$2,repository_root,checkout_root,record||jsonb_build_object('executionId',$2::text)
        from run_worktrees where run_id=$1 and allocation_id=$3`, [f.run.id, completed.id, f.reviewer.id])
      await expect(new PostgresWorkflowClosureStore(f.db.pool).begin(completed)).resolves.toBeDefined()
      expect(await f.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)).toMatchObject({ state: 'pending' })
    } finally { await f.close() }
  }, 60_000)

  it.each([false, true])('keeps a reviewer checkout separate from the next workflow turn (cleanup pending=%s)', async failed => {
    const f = await fixture()
    try {
      if (failed) await f.failReview()
      const execution = await f.incoming()
      const tree = (await f.trees.prepare(AcceptedWorkflowRunV3Schema.parse(f.run),
        AbortSignal.timeout(30_000), execution.id))!
      expect(tree.workingDirectory).not.toBe(f.reviewer.workingDirectory)
      expect(await f.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId))
        .toMatchObject({ id: f.job.id, state: failed ? 'failed' : 'pending' })
    } finally { await f.close() }
  }, 60_000)

  it.each([false, true])('preserves a terminal Run checkout until review obligations settle (cleanup pending=%s)', async failed => {
    const f = await fixture()
    try {
      if (failed) await f.failReview()
      await f.engine.shutdown()
      const job = await f.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)
      expect(job).toMatchObject({ state: failed ? 'failed' : 'pending' })
      if (failed) expect(job!.cleanup).toMatchObject({ nativeState: 'pending', credentialState: 'pending' })
      await f.db.pool.query(`update runs set execution_state='interrupted',
        record=jsonb_set(record,'{executionState}','"interrupted"'::jsonb) where id=$1`, [f.run.id])
      const errors: unknown[] = []
      await f.trees.cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      await access(f.reviewer.workingDirectory!)
      const row = (await f.db.pool.query<{ record: unknown }>(
        'select record from run_worktrees where run_id=$1 and allocation_id=$2', [f.run.id, f.reviewer.id])).rows[0]!
      expect(RunWorktreeSchema.parse(row.record)).toMatchObject({ state: 'active', workingDirectory: f.reviewer.workingDirectory })
    } finally { await f.close() }
  }, 60_000)
})
