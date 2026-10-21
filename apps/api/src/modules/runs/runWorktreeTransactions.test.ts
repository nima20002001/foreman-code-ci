import type pg from 'pg'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AcceptedWorkflowRunV3, RunWorktree } from '@foreman-code/contracts/wave25'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { RunWorktrees } from './runWorktrees.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(options: { existing?: boolean; stopDuringFetch?: boolean } = {}) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'run-worktree-'))
  directories.push(root)
  const run = { id: 'run', workspaceId: 'workspace', executionLocation: { rootPath: root } } as AcceptedWorkflowRunV3
  let inTransaction = false
  let stopped = false
  let tree: RunWorktree | undefined = options.existing ? {
    workingDirectory: join(root, 'managed', 'existing'), branch: 'foreman/existing',
    baseCommit: 'a'.repeat(40), state: 'active',
  } : undefined
  let exists = options.existing === true
  const query = async (text: string, values: unknown[] = []) => {
    if (text.startsWith('begin')) inTransaction = true
    if (text === 'commit' || text === 'rollback') inTransaction = false
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 }
    if (text.includes('select w.run_id')) {
      return { rows: tree ? [{ run_id: run.id, allocation_id: '' }] : [], rowCount: tree ? 1 : 0 }
    }
    if (text.includes('from run_worktrees')) {
      return { rows: tree ? [{ repository_root: root, record: structuredClone(tree),
        checkout_root: tree.workingDirectory, cleanup_attempts: 0 }] : [], rowCount: tree ? 1 : 0 }
    }
    if (text.includes('from harness_executions')) return { rows: [], rowCount: 0 }
    if (text.includes('select 1 from runs r')) return { rows: stopped ? [{}] : [], rowCount: stopped ? 1 : 0 }
    if (text.includes('from runs')) return { rows: [{ execution_state: stopped ? 'completed' : 'running' }], rowCount: 1 }
    if (text.startsWith('insert into run_worktrees')) tree = JSON.parse(String(values[2]))
    if (text.startsWith('update run_worktrees set record=')) tree = JSON.parse(String(values[1]))
    return { rows: [], rowCount: 1 }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const ports: GitWorktreePorts = {
    cloneDirectory: () => root,
    async git(args) {
      if (!options.stopDuringFetch) expect(inTransaction).toBe(false)
      let stdout = ''
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stdout = root
      else if (args[0] === 'remote') stdout = 'https://example.invalid/repository.git'
      else if (args[0] === 'ls-remote') stdout = 'ref: refs/heads/main\tHEAD\n'
      else if (args[0] === 'fetch' && options.stopDuringFetch) stopped = true
      else if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') stdout = root
      else if (args[0] === 'rev-parse' && args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' }
      else if (args[0] === 'rev-parse') stdout = 'a'.repeat(40)
      else if (args[0] === 'worktree' && args[1] === 'list') stdout = exists ? `worktree ${tree!.workingDirectory}\n` : ''
      else if (args[0] === 'worktree' && args[1] === 'add') exists = true
      else if (args[0] === 'worktree' && args[1] === 'remove') exists = false
      else if (args[0] === 'symbolic-ref') stdout = tree!.branch
      else if (args[0] === 'config') stdout = 'configured'
      return { code: 0, stdout, stderr: '' }
    },
  }
  return { service: new RunWorktrees(pool, join(root, 'managed'), ports), run,
    tree: () => tree, stop: () => { stopped = true } }
}

it('fetches and creates a Run checkout with no open database transaction', async () => {
  const f = await fixture()
  const tree = await f.service.prepare(f.run)
  expect(tree).toMatchObject({ state: 'active', baseCommit: 'a'.repeat(40) })
  expect(f.tree()).toEqual(tree)
})

it('checks eligibility and persists cleanup separately from Git I/O', async () => {
  const f = await fixture({ existing: true })
  f.stop()
  const failures: unknown[] = []
  await f.service.cleanup(error => failures.push(error))
  expect(failures).toEqual([])
  expect(f.tree()).toMatchObject({ state: 'removed' })
})

it('does not allocate a checkout when the Run ends while fetching its default branch', async () => {
  const f = await fixture({ stopDuringFetch: true })
  await expect(f.service.prepare(f.run)).rejects.toMatchObject({ code: 'RUN_WORKTREE_CLOSED' })
  expect(f.tree()).toBeUndefined()
})
