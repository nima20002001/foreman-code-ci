import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema } from '@foreman-code/contracts/wave25'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { canContinueWorkflowSession } from '../src/modules/runs/sessionContinuation.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { deferred } from './helpers/deferred.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'

async function fixture() {
  const db = await agent3Database()
  const env = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  try {
    const f = await seedAgent3(db.pool, db.directory)
    git(db.directory, 'init', '-b', 'main')
    await writeFile(join(db.directory, 'project.txt'), 'default branch\n')
    git(db.directory, 'add', 'project.txt')
    git(db.directory, 'commit', '-m', 'Project')
    const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, executionState: 'running' })
    await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [run.id, run.executionState, JSON.stringify(run)])
    const ports = systemGitWorktreePorts(env)
    const managed = join(db.directory, 'managed')
    const service = new RunWorktrees(db.pool, managed, ports)
    const node = f.version.definition.nodes[0]!
    async function persist(execution: HarnessExecution) {
      await db.pool.query('update harness_executions set record=$2::jsonb where id=$1',
        [execution.id, JSON.stringify(execution)])
      return execution
    }
    return { db, run, git, service, ports, managed,
      async execution(attempt: number) {
        const execution = HarnessExecutionSchema.parse({ id: `writer-${attempt}`, runId: run.id,
          workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId],
          attempt, state: 'queued', input: {}, createdAt: new Date(Date.now() + attempt * 1000).toISOString() })
        await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record,created_at)
          values($1,$2,$3,$4,$5,$6::jsonb,$7)`, [execution.id, run.id, node.id, node.agentId,
          attempt, JSON.stringify(execution), execution.createdAt])
        return execution
      },
      async prepare(execution: HarnessExecution) {
        const tree = (await service.prepare(run, AbortSignal.timeout(30_000), execution.id))!
        return { tree, execution: await persist({ ...execution, workingDirectory: tree.workingDirectory }) }
      },
      async finish(execution: HarnessExecution, finalized = true) {
        const completed = HarnessExecutionSchema.parse({ ...execution, state: 'completed',
          nativeSessionId: 'retained-session', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
        await persist(completed)
        await db.pool.query(`insert into execution_native_sessions(execution_id,reference,workflow_finalized_at)
          values($1,$2::jsonb,$3)`, [execution.id,
          JSON.stringify({ harness: 'codex', providerVersion: 'fixture', nativeSessionId: completed.nativeSessionId }),
          finalized ? new Date() : null])
        return completed
      },
      async trees() {
        return (await db.pool.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [run.id]))
          .rows.map(row => RunWorktreeSchema.parse(row.record))
      },
    }
  } catch (error) {
    await db.close()
    throw error
  }
}

describe.runIf(postgresEnabled)('Local Agent checkout continuity', () => {
  it('does not reuse a finalized workflow checkout while a later native lifetime is open', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const completed = await f.finish(first.execution)
      await new PostgresWorkflowClosureStore(f.db.pool).begin(completed)
      const second = await f.prepare(await f.execution(2))
      expect(second.tree.workingDirectory).not.toBe(first.tree.workingDirectory)
      await writeFile(join(first.tree.workingDirectory, 'review.txt'), 'review in progress')
      await expect(access(join(second.tree.workingDirectory, 'review.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.db.close() }
  })

  it('does not clean an obsolete checkout while a reviewer native lifetime remains open', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const second = await f.prepare(await f.execution(2))
      const completed = await f.finish(first.execution)
      const closures = new PostgresWorkflowClosureStore(f.db.pool)
      const generation = await closures.begin(completed)
      const errors: unknown[] = []
      await f.service.cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      await access(first.tree.workingDirectory)
      expect((await f.trees()).find(tree => tree.executionId === first.execution.id)?.state).toBe('active')
      await closures.record(completed, { harness: 'codex', providerVersion: 'fixture',
        nativeSessionId: completed.nativeSessionId! }, generation, () => undefined)
      await f.service.cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      await expect(access(first.tree.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      await access(second.tree.workingDirectory)
    } finally { await f.db.close() }
  })

  it('keeps a detached reviewer checkout reserved until its replacement native lifetime closes', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const completed = await f.finish(first.execution)
      const closures = new PostgresWorkflowClosureStore(f.db.pool)
      const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: completed.nativeSessionId! }
      const detached = await closures.begin(completed)
      await closures.recordDetached(completed, session, detached, () => undefined)
      const second = await f.prepare(await f.execution(2))
      expect(second.tree.workingDirectory).not.toBe(first.tree.workingDirectory)
      const replacement = await closures.begin(completed)
      await closures.record(completed, session, replacement, () => undefined)
      const third = await f.prepare(await f.execution(3))
      expect(third.tree.workingDirectory).toBe(first.tree.workingDirectory)
    } finally { await f.db.close() }
  })

  it('rejects reviewer attachment after a new execution claims the checkout', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const completed = await f.finish(first.execution)
      const second = await f.prepare(await f.execution(2))
      expect(second.tree.workingDirectory).toBe(first.tree.workingDirectory)
      await expect(new PostgresWorkflowClosureStore(f.db.pool).begin(completed))
        .rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    } finally { await f.db.close() }
  })

  it('serializes reviewer lifetime admission against checkout reuse', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const completed = await f.finish(first.execution)
      const incoming = await f.execution(2)
      const [review, preparation] = await Promise.allSettled([
        new PostgresWorkflowClosureStore(f.db.pool).begin(completed), f.prepare(incoming),
      ])
      expect(preparation.status).toBe('fulfilled')
      if (preparation.status !== 'fulfilled') throw preparation.reason
      if (review.status === 'fulfilled') {
        expect(preparation.value.tree.workingDirectory).not.toBe(first.tree.workingDirectory)
      } else {
        expect(review.reason).toMatchObject({ code: 'SESSION_LANE_BUSY' })
        expect(preparation.value.tree.workingDirectory).toBe(first.tree.workingDirectory)
      }
    } finally { await f.db.close() }
  })

  it.each([false, true])('prepares an unrelated checkout while another Agent is blocked in Git (recovery=%s)', async recovery => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    let slow: Promise<unknown> | undefined
    try {
      const unrelated = await f.execution(1)
      const existing = recovery ? await f.prepare(unrelated) : undefined
      let blocked = false
      const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
        if (!blocked && args[0][0] === 'worktree' && args[0][1] === 'add') {
          blocked = true
          entered.resolve()
          await release.promise
        }
        return f.ports.git(...args)
      } }
      const service = new RunWorktrees(f.db.pool, f.managed, ports)
      const other = await f.execution(2)
      slow = service.prepare(f.run, AbortSignal.timeout(30_000), other.id)
      await Promise.race([entered.promise, slow.then(() => { throw new Error('Expected blocked Git preparation') })])
      const prepared = await service.prepare(f.run, AbortSignal.timeout(5_000), unrelated.id)
      expect(prepared).toBeDefined()
      if (existing) expect(prepared).toEqual(existing.tree)
      expect(await readFile(join(prepared!.workingDirectory, 'project.txt'), 'utf8')).toBe('default branch\n')
      expect(f.db.pool.waitingCount).toBe(0)
    } finally {
      release.resolve()
      try { await slow } finally { await f.db.close() }
    }
  })

  it('keeps files, commits and session eligibility across serialized turns and a service restart', async () => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      await writeFile(join(first.tree.workingDirectory, 'committed.txt'), 'first turn commit\n')
      f.git(first.tree.workingDirectory, 'add', 'committed.txt')
      f.git(first.tree.workingDirectory, 'commit', '-m', 'Agent commit')
      const head = f.git(first.tree.workingDirectory, 'rev-parse', 'HEAD')
      await writeFile(join(first.tree.workingDirectory, 'uncommitted.txt'), 'first turn edit\n')
      const previous = await f.finish(first.execution)
      const execution = await f.execution(2)
      const tree = (await new RunWorktrees(f.db.pool, f.managed, f.ports)
        .prepare(f.run, AbortSignal.timeout(30_000), execution.id))!
      expect(tree.workingDirectory).toBe(first.tree.workingDirectory)
      expect(tree.branch).toBe(first.tree.branch)
      expect(f.git(tree.workingDirectory, 'rev-parse', 'HEAD')).toBe(head)
      expect(await readFile(join(tree.workingDirectory, 'committed.txt'), 'utf8')).toBe('first turn commit\n')
      expect(await readFile(join(tree.workingDirectory, 'uncommitted.txt'), 'utf8')).toBe('first turn edit\n')
      expect(canContinueWorkflowSession(previous, { ...execution, workingDirectory: tree.workingDirectory })).toBe(true)
      expect(await f.trees()).toEqual(expect.arrayContaining([
        expect.objectContaining({ executionId: first.execution.id, workingDirectory: tree.workingDirectory }),
        expect.objectContaining({ executionId: execution.id, workingDirectory: tree.workingDirectory }),
      ]))
    } finally { await f.db.close() }
  })

  it('bounds physical checkouts while a Run keeps producing finalized interval turns', async () => {
    const f = await fixture()
    try {
      const directories = new Set<string>()
      const errors: unknown[] = []
      for (let attempt = 1; attempt <= 8; attempt++) {
        const prepared = await f.prepare(await f.execution(attempt))
        directories.add(prepared.tree.workingDirectory)
        await f.finish(prepared.execution)
        await f.service.cleanup(error => errors.push(error))
      }
      expect(errors).toEqual([])
      expect(directories.size).toBe(1)
      const listed = f.git(f.db.directory, 'worktree', 'list', '--porcelain')
      expect(listed.split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(2)
      expect((await f.db.pool.query('select execution_state from runs where id=$1', [f.run.id])).rows)
        .toEqual([{ execution_state: 'running' }])
    } finally { await f.db.close() }
  })

  it.each([false, true])('reclaims obsolete checkouts during an active Run after native finalization (dirty=%s)', async dirty => {
    const f = await fixture()
    try {
      const first = await f.prepare(await f.execution(1))
      const second = await f.prepare(await f.execution(2))
      expect(second.tree.workingDirectory).not.toBe(first.tree.workingDirectory)
      if (dirty) await writeFile(join(first.tree.workingDirectory, 'keep.txt'), 'retained work\n')
      await f.finish(first.execution, false)
      const errors: unknown[] = []
      const report = (error: unknown) => errors.push(error)
      await f.service.cleanup(report)
      await access(first.tree.workingDirectory)
      await f.db.pool.query('update execution_native_sessions set workflow_finalized_at=now() where execution_id=$1',
        [first.execution.id])
      const now = new Date()
      await f.service.cleanup(report, now)
      expect((await f.trees()).find(tree => tree.executionId === first.execution.id)?.state)
        .toBe(dirty ? 'retained' : 'removed')
      if (dirty) {
        expect(await readFile(join(first.tree.workingDirectory, 'keep.txt'), 'utf8')).toBe('retained work\n')
        f.git(first.tree.workingDirectory, 'add', 'keep.txt')
        f.git(first.tree.workingDirectory, 'commit', '-m', 'Keep work')
        await f.service.cleanup(report, new Date(now.getTime() + 5 * 60_000))
        expect(f.git(f.db.directory, 'show', `${first.tree.branch}:keep.txt`)).toBe('retained work')
      }
      expect(errors).toEqual([])
      await expect(access(first.tree.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      await access(second.tree.workingDirectory)
    } finally { await f.db.close() }
  })
})
