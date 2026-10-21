import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

async function fixture() {
  const db = await agent3Database()
  const env = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  try {
    const seeded = await seedAgent3(db.pool, db.directory)
    git(db.directory, 'init', '-b', 'main')
    await mkdir(join(db.directory, 'apps', 'api'), { recursive: true })
    await writeFile(join(db.directory, 'project.txt'), 'project\n')
    await writeFile(join(db.directory, 'apps', 'api', 'service.txt'), 'service\n')
    git(db.directory, 'add', 'project.txt', 'apps')
    git(db.directory, 'commit', '-m', 'Project')
    const run = AcceptedWorkflowRunV3Schema.parse(seeded.run)
    const ports = systemGitWorktreePorts(env)
    const managed = join(db.directory, 'managed')
    return { db, run, ports, managed, git, service: new RunWorktrees(db.pool, managed, ports),
      async stop() {
        const record = { ...run, executionState: 'interrupted' }
        await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
          [run.id, record.executionState, JSON.stringify(record)])
      },
      async trees() {
        const rows = await db.pool.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [run.id])
        return rows.rows.map(row => RunWorktreeSchema.parse(row.record))
      },
    }
  } catch (error) {
    await db.close()
    throw error
  }
}

describe.runIf(postgresEnabled)('Local execution worktree preparation', () => {
  it('exposes each execution checkout through authenticated MCP and denies unauthorized readers', async () => {
    let service: RunWorktrees
    let runtimeRoot: string
    const f = await currentOperatorIntegration({ preparePlacementExecution: async (_owner, run, execution) => {
      const tree = await service.prepare(run, AbortSignal.timeout(30_000), execution.id)
      if (!tree) throw new Error('Expected an execution worktree')
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(runtimeRoot, { workspaceId: run.workspaceId,
          workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id,
          executionSemanticsVersion: 3 }, execution),
        revalidate: () => service.verify(tree) }
    } })
    try {
      runtimeRoot = f.db.directory
      const env = gitFixtureEnvironment()
      const git = (...args: string[]) => execFileSync('git', args, { cwd: runtimeRoot, env, encoding: 'utf8' }).trim()
      git('init', '-b', 'main')
      await writeFile(join(runtimeRoot, 'project.txt'), 'project\n')
      git('add', 'project.txt')
      git('commit', '-m', 'Project')
      service = new RunWorktrees(f.db.pool, join(runtimeRoot, 'managed'), systemGitWorktreePorts(env))
      vi.mocked(f.locations.revalidateSnapshot).mockRestore()
      const location = await f.locations.set(f.writer.principal, 'mcp', {
        workspaceId: f.f.run.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: f.locations.runnerId, rootPath: runtimeRoot,
      })
      const denied = await f.access.issue({ name: 'Denied Run reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [] })
      const workflow = (await f.db.pool.query<{ revision: string }>(
        'select revision::text from workflows where id=$1', [f.f.run.workflowId])).rows[0]!
      const input = { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId,
        workflowVersionId: f.f.version.id, executionSemanticsVersion: 3, input: {},
        expectedWorkflowRevision: Number(workflow.revision),
        expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.value.locationRevision }
      const deniedClient = await f.connect(denied.token)
      expect((await deniedClient.callTool({ name: 'run_start', arguments: input })).isError).toBe(true)
      const started = await f.client.callTool({ name: 'run_start', arguments: input })
      expect(started.isError, JSON.stringify(started)).not.toBe(true)
      const runId = RunStartV3ResultSchema.parse(decodeMcpToolResult(started)).run.id
      await expect.poll(async () => (await f.runs.get(runId))?.executionState, { timeout: 10_000 }).toBe('waiting')
      const args = { workspaceId: f.f.run.workspaceId, runId, detail: 'full' }
      const details = OperatorRunGetResultSchema.parse(decodeMcpToolResult(
        await f.client.callTool({ name: 'run_get', arguments: args })))
      if ('detail' in details) throw new Error('Expected full Run details')
      expect(details.executions.length).toBeGreaterThan(1)
      expect(details.worktrees).toHaveLength(details.executions.length)
      expect(new Set(details.executions.map(execution => execution.workingDirectory)).size).toBe(details.executions.length)
      for (const execution of details.executions) {
        expect(details.worktrees).toContainEqual(expect.objectContaining({
          executionId: execution.id, workingDirectory: execution.workingDirectory, state: 'active',
        }))
      }
      const stored = await f.db.pool.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [runId])
      expect(stored.rows.map(row => RunWorktreeSchema.parse(row.record)))
        .toEqual(expect.arrayContaining(details.worktrees!))
      expect((await deniedClient.callTool({ name: 'run_get', arguments: args })).isError).toBe(true)
      const reader = await f.access.issue({ name: 'Run reader without location', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [f.f.run.workspaceId] } }] })
      const redacted = OperatorRunGetResultSchema.parse(decodeMcpToolResult(
        await (await f.connect(reader.token)).callTool({ name: 'run_get', arguments: args })))
      expect(redacted).not.toHaveProperty('worktrees')
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  })

  it('isolates concurrent writable executions in the same Run and recovers each allocation', async () => {
    const f = await fixture()
    try {
      const signal = AbortSignal.timeout(30_000)
      const [first, second] = await Promise.all([
        f.service.prepare(f.run, signal, 'writer-one'),
        f.service.prepare(f.run, signal, 'writer-two'),
      ])
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(second!.workingDirectory).not.toBe(first!.workingDirectory)
      expect(second!.branch).not.toBe(first!.branch)
      await writeFile(join(first!.workingDirectory, 'project.txt'), 'first writer\n')
      expect(await readFile(join(second!.workingDirectory, 'project.txt'), 'utf8')).toBe('project\n')
      const recovered = new RunWorktrees(f.db.pool, f.managed, f.ports)
      expect(await recovered.prepare(f.run, signal, 'writer-one')).toEqual(first)
      expect(await recovered.prepare(f.run, signal, 'writer-two')).toEqual(second)
      expect(await f.trees()).toEqual(expect.arrayContaining([first, second]))
      expect(await f.trees()).toHaveLength(2)
    } finally { await f.db.close() }
  })

  it('leaves pool clients available while Git and duplicate preparations wait', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
      if (args[0][0] === 'worktree' && args[0][1] === 'add') {
        entered()
        await blocked
      }
      return f.ports.git(...args)
    } }
    const service = new RunWorktrees(f.db.pool, f.managed, ports)
    const pending = Array.from({ length: 12 }, () => service.prepare(f.run))
    let results: Awaited<ReturnType<typeof Promise.allSettled>>
    try {
      await started
      expect(f.db.pool.totalCount - f.db.pool.idleCount).toBe(0)
      expect(f.db.pool.waitingCount).toBe(0)
      expect((await f.db.pool.query('select 1 as available')).rows).toEqual([{ available: 1 }])
    } finally {
      release()
      results = await Promise.allSettled(pending)
      await f.db.close()
    }
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
  })

  it.each([
    { state: 'preparing', indexLocked: false }, { state: 'retained', indexLocked: false },
    { state: 'preparing', indexLocked: true }, { state: 'retained', indexLocked: true },
  ])('finishes an interrupted checkout after restart while preserving files (%j)', async ({ state, indexLocked }) => {
    const f = await fixture()
    let allocated!: string
    const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
      if (args[0][0] === 'worktree' && args[0][1] === 'add') {
        const result = await f.ports.git([...args[0], '--no-checkout'], args[1])
        expect(result.code).toBe(0)
        allocated = args[0][args[0].length - 2]!
        await writeFile(join(allocated, 'keep.txt'), 'partial preparation\n')
        await writeFile(join(allocated, 'project.txt'), 'preparation edit\n')
        if (indexLocked) {
          const index = f.git(allocated, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
          await writeFile(`${index}.lock`, 'Interrupted index write')
        }
        throw new Error('Checkout interrupted')
      }
      return f.ports.git(...args)
    } }
    try {
      await expect(new RunWorktrees(f.db.pool, f.managed, ports).prepare(f.run)).rejects.toThrow('Checkout interrupted')
      await f.db.pool.query(`update run_worktrees set record=jsonb_set(record,'{state}',to_jsonb($2::text))
        where run_id=$1`, [f.run.id, state])
      const tree = await f.service.prepare(f.run)
      expect(tree).toMatchObject({ state: 'active', workingDirectory: allocated })
      expect(await readFile(join(allocated, 'keep.txt'), 'utf8')).toBe('partial preparation\n')
      expect(await readFile(join(allocated, 'project.txt'), 'utf8')).toBe('preparation edit\n')
      expect(await readFile(join(allocated, 'apps', 'api', 'service.txt'), 'utf8')).toBe('service\n')
      expect(await f.trees()).toEqual([tree])
      expect(await f.service.prepare(f.run)).toEqual(tree)
      f.git(allocated, 'add', 'keep.txt', 'project.txt')
      f.git(allocated, 'commit', '-m', 'Keep preparation edits')
      expect(f.git(allocated, 'show', 'HEAD:keep.txt')).toBe('partial preparation')
    } finally { await f.db.close() }
  })

  it('keeps the selected repository subfolder as the execution working directory', async () => {
    const f = await fixture()
    try {
      const selected = { ...f.run, executionLocation: {
        ...f.run.executionLocation, rootPath: join(f.db.directory, 'apps', 'api'),
      } }
      const tree = await f.service.prepare(selected)
      expect(tree).toBeDefined()
      const checkout = f.git(tree!.workingDirectory, 'rev-parse', '--show-toplevel')
      expect(tree!.workingDirectory).toBe(join(checkout, 'apps', 'api'))
      expect(await readFile(join(tree!.workingDirectory, 'service.txt'), 'utf8')).toBe('service\n')
      await f.stop()
      const errors: unknown[] = []
      await f.service.cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.db.close() }
  })

  it('retries retained worktrees with backoff and removes them only after their edits are committed', async () => {
    const f = await fixture()
    try {
      const tree = (await f.service.prepare(f.run))!
      await writeFile(join(tree.workingDirectory, 'keep.txt'), 'retained edit\n')
      await f.stop()
      let inspections = 0
      const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
        if (args[0][0] === 'status') inspections += 1
        return f.ports.git(...args)
      } }
      const service = new RunWorktrees(f.db.pool, f.managed, ports)
      const errors: unknown[] = []
      const report = (error: unknown) => errors.push(error)
      const now = new Date()
      await service.cleanup(report, now)
      expect(await f.trees()).toEqual([expect.objectContaining({ state: 'retained' })])
      expect(inspections).toBe(1)
      await service.cleanup(report, new Date(now.getTime() + 60_000))
      expect(inspections).toBe(1)
      await service.cleanup(report, new Date(now.getTime() + 5 * 60_000))
      expect(inspections).toBe(2)
      expect(await readFile(join(tree.workingDirectory, 'keep.txt'), 'utf8')).toBe('retained edit\n')
      f.git(tree.workingDirectory, 'add', 'keep.txt')
      f.git(tree.workingDirectory, 'commit', '-m', 'Keep edits')
      await service.cleanup(report, new Date(now.getTime() + 6 * 60_000))
      expect(inspections).toBe(2)
      await service.cleanup(report, new Date(now.getTime() + 15 * 60_000))
      expect(errors).toEqual([])
      expect(await f.trees()).toEqual([expect.objectContaining({ state: 'removed' })])
      await expect(access(tree.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.git(f.db.directory, 'show', `${tree.branch}:keep.txt`)).toBe('retained edit')
    } finally { await f.db.close() }
  })
})
