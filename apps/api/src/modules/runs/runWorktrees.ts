import { latestDefaultCommit, runWorkspaceGit } from '../sources/defaultBranch.js'
import { withTransaction } from '../../infrastructure/transaction.js'
export { latestDefaultCommit } from '../sources/defaultBranch.js'
import { removeCommittedWorktree } from '../sources/worktreeCleanup.js'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, open, rename } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type pg from 'pg'
import { RunWorktreeSchema, type RunWorktree, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { ensureWorktreeGitIdentity, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { directoryFlags, withPrivateDirectoryLock } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'
import { reuseRunCheckout, runWorktreeCleanupCondition, type WorktreeAllocationRow } from './runWorktreeLifecycle.js'

type Sql = Pick<pg.PoolClient, 'query'>
type Allocation = { root: string; checkoutRoot: string; record: RunWorktree; cleanupAttempts: number }
const CLEANUP_RETRY_MS = 5 * 60_000

/** Concurrent writers have separate checkouts; serialized turns of a node retain their working files. */
export class RunWorktrees {
  private readonly gitLifetime = new AsyncLocalStorage<number>()
  private readonly ports: GitWorktreePorts

  constructor(private readonly pool: pg.Pool, private readonly managedRoot: string,
    ports: GitWorktreePorts = systemGitWorktreePorts()) {
    this.ports = { ...ports, git: (args, options) => {
      const lifetimeLockFd = this.gitLifetime.getStore()
      return ports.git(args, lifetimeLockFd === undefined ? options : { ...options, lifetimeLockFd })
    } }
  }

  private async exclusive<T>(identity: string, signal: AbortSignal,
    work: () => Promise<T>): Promise<T> {
    const key = createHash('sha256').update(identity).digest('hex')
    const path = join(this.managedRoot, '.locks', key)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const directory = await open(path, directoryFlags)
    try {
      // Git supervisors retain the lock after an API crash until their last child exits.
      return await withPrivateDirectoryLock(directory, guard => this.gitLifetime.run(guard.fd, work), { signal })
    } finally {
      await directory.close()
    }
  }

  private coordinate<T>(runId: string, work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async sql => {
      await sql.query('select id from runs where id=$1 for no key update', [runId])
      return work(sql)
    })
  }

  private async requireActiveRun(sql: Sql, runId: string): Promise<void> {
    const terminal = (await sql.query<{ execution_state: string }>(
      'select execution_state from runs where id=$1 for share', [runId])).rows[0]
    if (!terminal || ['completed', 'interrupted'].includes(terminal.execution_state)) {
      throw new DomainError('RUN_WORKTREE_CLOSED', 'A terminal Run cannot allocate a worktree.', 409)
    }
  }

  private async inspectAllocation(sql: Sql, run: AcceptedWorkflowRunV3, allocationId: string) {
    const previous = await this.read(sql, run.id, allocationId)
    if (previous) {
      if (previous.record.state === 'removed') {
        throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is already closed.', 409)
      }
      if (previous.record.state === 'retained') await this.reopenPreparation(sql, run.id, allocationId, previous)
      return { kind: 'existing' as const, tree: previous }
    }
    const started = (await sql.query<{ directory: string }>(
      `select record->>'workingDirectory' as directory from harness_executions
        where run_id=$1 and ($2='' or id=$2) and record->>'workingDirectory' is not null limit 1`,
      [run.id, allocationId])).rows[0]
    if (started) {
      if (allocationId) {
        const previous = await this.read(sql, run.id, '')
        if (previous?.record.workingDirectory === started.directory && previous.record.state === 'active') {
          return { kind: 'existing' as const, tree: previous }
        }
      }
      if (started.directory !== run.executionLocation.rootPath) {
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The accepted execution directory has no worktree record.', 409)
      }
      return { kind: 'skip' as const }
    }
    await this.requireActiveRun(sql, run.id)
    if (allocationId) {
      const reused = await reuseRunCheckout(sql, run.id, allocationId)
      if (reused) return { kind: 'existing' as const, tree: this.allocation(reused) }
    }
    return { kind: 'allocate' as const }
  }

  private async reopenPreparation(sql: Sql, runId: string, allocationId: string, tree: Allocation) {
    await this.requireActiveRun(sql, runId)
    const started = await sql.query(`select 1 from harness_executions e where e.run_id=$1
      and (e.id=$2 or e.record->>'workingDirectory'=$3)
      and (e.record->>'state'<>'queued' or e.record->>'nativeSessionId' is not null
        or exists(select 1 from execution_native_sessions n where n.execution_id=e.id)) limit 1`,
    [runId, allocationId, tree.record.workingDirectory])
    if (started.rows.length) throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is already closed.', 409)
    tree.record = { ...tree.record, state: 'preparing' }
    delete tree.record.message
    await this.update(sql, runId, allocationId, tree.record)
  }

  private async reserveAllocation(run: AcceptedWorkflowRunV3, allocationId: string, signal: AbortSignal) {
    const root = run.executionLocation.rootPath
    const probe = await this.ports.git(['rev-parse', '--show-toplevel'], { cwd: root, signal })
    if (probe.code !== 0) {
      if (!probe.stderr.includes('not a git repository')) {
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The workspace Git repository could not be inspected.', 409)
      }
      return undefined
    }
    const repositoryRoot = probe.stdout.trim()
    const baseCommit = await latestDefaultCommit(this.ports, repositoryRoot, signal)
    const { branch, checkoutRoot } = this.checkoutIdentity(run, allocationId)
    const workingDirectory = join(checkoutRoot, relative(repositoryRoot, root))
    const record = RunWorktreeSchema.parse({ workingDirectory, branch, baseCommit, state: 'preparing',
      ...(allocationId ? { executionId: allocationId } : {}) })
    return this.coordinate(run.id, async sql => {
      await this.requireActiveRun(sql, run.id)
      await sql.query(`insert into run_worktrees(run_id,repository_root,record,allocation_id,checkout_root)
        values($1,$2,$3::jsonb,$4,$5)`,
      [run.id, repositoryRoot, JSON.stringify(record), allocationId, checkoutRoot])
      return { root: repositoryRoot, checkoutRoot, record, cleanupAttempts: 0 }
    })
  }

  private checkoutIdentity(run: AcceptedWorkflowRunV3, allocationId: string) {
    const namespace = createHash('sha256').update(run.workspaceId).digest('hex')
    const name = createHash('sha256').update(run.id).update('\0').update(allocationId).digest('hex')
    const branch = `foreman/run-${name}`
    return { branch, checkoutRoot: join(this.managedRoot, namespace, branch.slice('foreman/'.length)) }
  }

  async prepare(run: AcceptedWorkflowRunV3, signal = AbortSignal.timeout(60_000),
    executionId = ''): Promise<RunWorktree | undefined> {
    return this.exclusive(`execution:${run.id}\0${executionId}`, signal, async () => {
      const state = await this.coordinate(run.id, sql => this.inspectAllocation(sql, run, executionId))
      if (state.kind === 'skip') return undefined
      const checkoutRoot = state.kind === 'existing' ? state.tree.checkoutRoot
        : this.checkoutIdentity(run, executionId).checkoutRoot
      return this.exclusive(`checkout:${checkoutRoot}`, signal, async () => {
        if (state.kind === 'existing') {
          const current = await this.coordinate(run.id, sql => this.inspectAllocation(sql, run, executionId))
          if (current.kind !== 'existing') {
            throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The prepared checkout is no longer available.', 409)
          }
          await this.prepareCheckout(run.id, current.tree.record.executionId ?? '', current.tree, signal)
          return current.tree.record
        }
        const tree = await this.reserveAllocation(run, executionId, signal)
        if (!tree) return undefined
        await this.prepareCheckout(run.id, tree.record.executionId ?? '', tree, signal)
        return tree.record
      })
    })
  }

  private async prepareCheckout(runId: string, allocationId: string, tree: Allocation, signal: AbortSignal) {
    const listed = await runWorkspaceGit(this.ports, ['worktree', 'list', '--porcelain'], tree.root, signal)
    const exists = listed.split('\n').includes(`worktree ${tree.checkoutRoot}`)
    if (exists && tree.record.state === 'preparing') {
      await this.finishCheckout(tree, signal)
    }
    if (!exists) {
      await this.coordinate(runId, sql => this.requireActiveRun(sql, runId))
      tree.record = { ...tree.record, state: 'preparing' }
      await this.persist(runId, allocationId, tree.record)
      await mkdir(join(tree.checkoutRoot, '..'), { recursive: true, mode: 0o700 })
      const { branch, baseCommit } = tree.record
      const existing = await this.ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: tree.root, signal })
      const args = existing.code === 0 ? ['worktree', 'add', tree.checkoutRoot, branch]
        : ['worktree', 'add', '-b', branch, tree.checkoutRoot, baseCommit]
      await runWorkspaceGit(this.ports, args, tree.root, signal)
    }
    await this.verify(tree.record, signal)
    if (tree.record.state === 'preparing') {
      tree.record = { ...tree.record, state: 'active' }
      await this.coordinate(runId, async sql => {
        await this.requireActiveRun(sql, runId)
        await this.update(sql, runId, allocationId, tree.record)
      })
    }
  }

  private async finishCheckout(tree: Allocation, signal: AbortSignal) {
    const branch = await runWorkspaceGit(this.ports, ['symbolic-ref', '--quiet', '--short', 'HEAD'], tree.checkoutRoot, signal)
    if (branch !== tree.record.branch) {
      throw new DomainError('RUN_WORKTREE_CHANGED', 'The Run worktree is on another branch.', 409)
    }
    const index = await runWorkspaceGit(this.ports,
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'], tree.checkoutRoot, signal)
    // The inherited preparation lock proves the previous Git lifetime has ended. Preserve its unfinished index.
    try { await rename(`${index}.lock`, `${index}.interrupted-${randomUUID()}`) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try { await access(index) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await runWorkspaceGit(this.ports, ['read-tree', 'HEAD'], tree.checkoutRoot, signal)
    }
    const missing = await this.ports.git(['ls-files', '--deleted', '-z'], { cwd: tree.checkoutRoot, signal })
    if (missing.code !== 0) {
      throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The unfinished checkout index could not be read.', 409)
    }
    const paths = missing.stdout.split('\0').filter(Boolean)
    // checkout-index without --force fills missing files and refuses to overwrite files already present.
    for (let offset = 0; offset < paths.length; offset += 128) {
      await runWorkspaceGit(this.ports, ['checkout-index', '--', ...paths.slice(offset, offset + 128)],
        tree.checkoutRoot, signal)
    }
  }

  async verify(tree: RunWorktree, signal = AbortSignal.timeout(10_000)): Promise<void> {
    const branch = await runWorkspaceGit(this.ports, ['symbolic-ref', '--quiet', '--short', 'HEAD'], tree.workingDirectory, signal)
    if (branch !== tree.branch) throw new DomainError('RUN_WORKTREE_CHANGED', 'The Run worktree is on another branch.', 409)
    await ensureWorktreeGitIdentity(this.ports, tree.workingDirectory, signal)
  }

  private async read(sql: Sql, runId: string, allocationId: string): Promise<Allocation | undefined> {
    const row = (await sql.query<WorktreeAllocationRow>(`select repository_root,record,checkout_root,cleanup_attempts from run_worktrees
      where run_id=$1 and allocation_id=$2`, [runId, allocationId])).rows[0]
    return row ? this.allocation(row) : undefined
  }

  private allocation(row: WorktreeAllocationRow): Allocation {
    return { root: row.repository_root, checkoutRoot: row.checkout_root,
      record: RunWorktreeSchema.parse(row.record), cleanupAttempts: row.cleanup_attempts }
  }

  private async update(sql: Sql, runId: string, allocationId: string, record: RunWorktree) {
    await sql.query('update run_worktrees set record=$2::jsonb where run_id=$1 and allocation_id=$3',
      [runId, JSON.stringify(record), allocationId])
  }

  private persist(runId: string, allocationId: string, record: RunWorktree) {
    return this.coordinate(runId, sql => this.update(sql, runId, allocationId, record))
  }

  private async updateCheckout(sql: Sql, runId: string, checkoutRoot: string, record: RunWorktree) {
    await sql.query(`update run_worktrees set record=(record-'message')
      || jsonb_build_object('state',$2::jsonb->'state')
      || case when $2::jsonb ? 'message' then jsonb_build_object('message',$2::jsonb->'message') else '{}'::jsonb end
      where run_id=$1 and checkout_root=$3`, [runId, JSON.stringify(record), checkoutRoot])
  }

  async cleanup(report: (error: unknown) => void, now = new Date()): Promise<void> {
    const rows = await this.pool.query<{ run_id: string; allocation_id: string }>(
      `select w.run_id,w.allocation_id from run_worktrees w join runs r on r.id=w.run_id
      where ${runWorktreeCleanupCondition}
      order by w.cleanup_after,w.created_at limit 100`, [now])
    for (const row of rows.rows) {
      try { await this.cleanupAllocation(row.run_id, row.allocation_id, now) } catch (error) { report(error) }
    }
  }

  private async cleanupAllocation(runId: string, allocationId: string, now: Date): Promise<void> {
    const signal = AbortSignal.timeout(30_000)
    const allocation = await this.coordinate(runId, sql => this.read(sql, runId, allocationId))
    if (!allocation) return
    return this.exclusive(`checkout:${allocation.checkoutRoot}`, signal, async () => {
      const tree = await this.coordinate(runId, async sql => {
        const eligible = await sql.query(`select 1 from runs r join run_worktrees w on w.run_id=r.id
          where r.id=$2 and w.allocation_id=$3 and ${runWorktreeCleanupCondition} for share of r,w`,
        [now, runId, allocationId])
        if (eligible.rowCount !== 1) return undefined
        const current = await this.read(sql, runId, allocationId)
        if (!current || current.record.state === 'removed') return undefined
        const retryMs = Math.min(24 * 60 * 60_000, CLEANUP_RETRY_MS * 2 ** Math.min(current.cleanupAttempts, 9))
        // Claim before Git so a later reviewer attachment cannot enter this checkout.
        await this.updateCheckout(sql, runId, current.checkoutRoot,
          { ...current.record, state: 'retained', message: 'Checkout cleanup is in progress.' })
        await sql.query(`update run_worktrees set cleanup_attempts=cleanup_attempts+1,cleanup_after=$3
          where run_id=$1 and checkout_root=$2`, [runId, current.checkoutRoot, new Date(now.getTime() + retryMs)])
        return current
      })
      if (!tree) return
      const removed = await removeCommittedWorktree(this.ports, tree.root,
        { ...tree.record, workingDirectory: tree.checkoutRoot }, signal)
      const record = { ...removed, workingDirectory: tree.record.workingDirectory }
      if (record.state === 'removed') delete record.message
      await this.coordinate(runId, sql => this.updateCheckout(sql, runId, tree.checkoutRoot, record))
    })
  }
}
