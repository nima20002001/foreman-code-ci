import { execFileSync } from 'node:child_process'
import { writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema } from '@foreman-code/contracts/wave25'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'

describe.skipIf(!postgresEnabled)('Run worktree allocation recovery', () => {
  it.each([false, true])('cleans a failed allocation after terminality without another prepare (modified: %s)', async modified => {
    const db = await agent3Database()
    const env = gitFixtureEnvironment()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: db.directory, env, encoding: 'utf8' }).trim()
    try {
      const f = await seedAgent3(db.pool, db.directory)
      git('init', '-b', 'main')
      await writeFile(join(db.directory, 'project.txt'), 'project')
      git('add', 'project.txt')
      git('commit', '-m', 'Project')
      const ports = systemGitWorktreePorts(env)
      let allocated: string | undefined
      const faulty = { ...ports, git: async (...args: Parameters<typeof ports.git>) => {
        const result = await ports.git(...args)
        if (args[0][0] === 'worktree' && args[0][1] === 'add' && result.code === 0) {
          allocated = args[0][args[0].length - 2]
          if (modified) await writeFile(join(allocated!, 'keep.txt'), 'Keep this work')
          throw new Error('Allocation acknowledgement failed')
        }
        return result
      } }
      const worktrees = new RunWorktrees(db.pool, join(db.directory, 'managed'), faulty)
      await expect(worktrees.prepare(AcceptedWorkflowRunV3Schema.parse(f.run))).rejects.toThrow('Allocation acknowledgement failed')
      expect(allocated).toBeDefined()
      const interrupted = AcceptedWorkflowRunV3Schema.parse({ ...f.run, executionState: 'interrupted' })
      await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
        [f.run.id, interrupted.executionState, JSON.stringify(interrupted)])
      const persisted = (await db.pool.query<{ execution_state: string; record: unknown }>(
        'select execution_state,record from runs where id=$1', [f.run.id])).rows[0]!
      expect(persisted.execution_state).toBe('interrupted')
      expect(AcceptedWorkflowRunV3Schema.parse(persisted.record)).toEqual({
        ...f.run, executionState: 'interrupted',
      })
      const errors: unknown[] = []
      await new RunWorktrees(db.pool, join(db.directory, 'managed'), ports).cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      const stored = (await db.pool.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [f.run.id])).rows[0]
      const tree = RunWorktreeSchema.parse(stored?.record)
      expect(tree.workingDirectory).toBe(allocated)
      expect(tree.state).toBe(modified ? 'retained' : 'removed')
      if (modified) expect(await readFile(join(allocated!, 'keep.txt'), 'utf8')).toBe('Keep this work')
      else await expect(access(allocated!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(git('rev-parse', tree.branch)).toBe(tree.baseCommit)
    } finally { await db.close() }
  }, 60_000)
})
