import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { SourceMaterializationFileSchema } from '@foreman-code/contracts/source-materialization'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { decodeMcpToolResult, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { insertProviderRun } from './helpers/wave25Br1003Runtime.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { sourceWorkingTreePath } from '../src/modules/sources/sourceTreePaths.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'

function result(raw: Parameters<typeof decodeMcpToolResult>[0]) {
  return OperatorRunGetResultSchema.parse(decodeMcpToolResult(raw))
}

describe.runIf(postgresEnabled)('Run isolation and authenticated MCP readback', () => {
  it('starts isolated agent checkouts from a retained snapshot through MCP and persists their working directories', async () => {
    const f = await sourceWorktreeMcpFixture()
    try {
      const denied = await f.base.access.issue({ name: 'Run reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.input.workspaceId] } }] })
      await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_start',
        arguments: { ...f.input, commandId: randomUUID() } }))
      expect(await f.base.runs.listSummaries(f.input.workspaceId)).toHaveLength(0)
      const starts = await Promise.all([1, 2].map(async () => {
        const response = await f.client.callTool({ name: 'run_start',
          arguments: { ...f.input, commandId: randomUUID() } })
        expect(response.isError, JSON.stringify(response)).not.toBe(true)
        return RunStartV3ResultSchema.parse(decodeMcpToolResult(response)).run.id
      }))
      const directories: string[] = []
      const references = []
      for (const runId of starts) {
        await expect.poll(async () => {
          const details = result(await f.client.callTool({ name: 'run_get', arguments: {
            workspaceId: f.input.workspaceId, runId, detail: 'full' } }))
          if ('detail' in details) throw new Error('Expected full Run details')
          if (details.run.executionState === 'completed') {
            const failures = details.executions.map(execution => ({ id: execution.id, result: execution.result }))
            throw new Error(`Run completed before approval: ${JSON.stringify(failures)}`)
          }
          return details.run.executionState
        }, { timeout: 90_000 }).toBe('waiting')
        const persisted = result(await f.client.callTool({ name: 'run_get', arguments: {
          workspaceId: f.input.workspaceId, runId, detail: 'full' } }))
        if ('detail' in persisted) throw new Error('Expected full Run details')
        expect(persisted.executions).toHaveLength(2)
        for (const execution of persisted.executions) {
          const readback = RunPlacementGetResultSchema.parse(decodeMcpToolResult(await f.client.callTool({
            name: 'run_node_placement_get', arguments: { workspaceId: f.input.workspaceId,
              workflowId: f.input.workflowId, runId, nodeId: execution.workflowNodeId },
          }))).readback
          if (readback.evidence !== 'accepted') throw new Error('Expected accepted Agent placement')
          expect(readback.nativePlacements).toHaveLength(1)
          const native = readback.nativePlacements![0]!
          const receipt = native.materialization.receipt
          expect(native.executionId).toBe(execution.id)
          expect(native.workingTree.canonicalCwd).toBe(execution.workingDirectory)
          expect(native.materialization.finalDispatchBindingHash).toBe(native.bindingHash)
          expect(receipt.binding.snapshotId).toBe(f.source.snapshotId)
          const record = SourceMaterializationFileSchema.parse(JSON.parse(await readFile(
            join(receipt.binding.canonicalPath, receipt.materializationId, 'receipt.json'), 'utf8')))
          expect(record.snapshotReference).toBeDefined()
          references.push(record.snapshotReference)
          directories.push(sourceWorkingTreePath(receipt))
        }
      }
      expect(new Set(directories).size).toBe(4)
      for (const reference of references) expect(reference).toEqual(references[0])
      await writeFile(join(directories[0]!, 'app.txt'), 'Agent edit\n')
      for (const directory of directories.slice(1)) {
        expect(await readFile(join(directory, 'app.txt'), 'utf8')).toBe('approved source\n')
      }
      expect(await readFile(join(references[0]!.canonicalStorePath, f.source.snapshotId,
        'bytes', 'app.txt'), 'utf8')).toBe('approved source\n')
      expect(f.base.dispatchErrors).toEqual([])
    } finally {
      await f.close()
    }
  }, 240_000)

  it('isolates concurrent Runs, recovers their persisted checkout and respects read grants', async () => {
    let service: RunWorktrees
    let runtimeRoot: string
    const f = await currentOperatorIntegration({ preparePlacementExecution: async (_owner, run, execution) => {
      const tree = await service.prepare(run)
      if (!tree) return undefined
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(runtimeRoot, { workspaceId: run.workspaceId, workflowId: run.workflowId,
          workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, execution),
        revalidate: () => service.verify(tree) }
    } })
    try {
      const environment = gitFixtureEnvironment()
      const ports = systemGitWorktreePorts(environment)
      const root = f.db.directory
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' }).trim()
      runtimeRoot = root
      service = new RunWorktrees(f.db.pool, join(root, 'managed-worktrees'), ports)
      const run = AcceptedWorkflowRunV3Schema.parse(f.f.run)
      // Ordinary directories still use the accepted workspace location.
      expect(await service.prepare(run)).toBeUndefined()
      git('init', '-b', 'main')
      await writeFile(join(root, 'project.txt'), 'default branch')
      git('add', 'project.txt')
      git('commit', '-m', 'Default')
      const baseCommit = git('rev-parse', 'HEAD')
      git('checkout', '-b', 'unrelated-feature')
      await writeFile(join(root, 'project.txt'), 'uncommitted workspace changes')
      const secondFixture = structuredClone(f.f)
      secondFixture.run.id = `run-${randomUUID()}`
      secondFixture.scope.runId = secondFixture.run.id
      await insertProviderRun(f.db.pool, secondFixture)
      const secondRun = AcceptedWorkflowRunV3Schema.parse(secondFixture.run)
      const [first, second] = await Promise.all([service.prepare(run), service.prepare(secondRun)])
      expect(first).toMatchObject({ baseCommit, state: 'active' })
      expect(second?.workingDirectory).not.toBe(first?.workingDirectory)
      expect(second?.branch).not.toBe(first?.branch)
      await writeFile(join(first!.workingDirectory, 'project.txt'), 'first Run edit')
      expect(await readFile(join(second!.workingDirectory, 'project.txt'), 'utf8')).toBe('default branch')
      expect(await readFile(join(root, 'project.txt'), 'utf8')).toBe('uncommitted workspace changes')
      expect(git('branch', '--show-current')).toBe('unrelated-feature')
      expect(await new RunWorktrees(f.db.pool, join(root, 'managed-worktrees'), ports).prepare(run)).toEqual(first)
      await Promise.all([f.engine.start(run.id), f.engine.start(secondRun.id)])
      await expect.poll(async () => (await f.runs.get(run.id))?.executionState, { timeout: 30000 }).toBe('waiting')
      await expect.poll(async () => (await f.runs.get(secondRun.id))?.executionState, { timeout: 30000 }).toBe('waiting')
      const args = { workspaceId: run.workspaceId, runId: run.id }
      expect(result(await f.client.callTool({ name: 'run_get', arguments: args }))).toMatchObject({ worktrees: [first] })
      const full = result(await f.client.callTool({ name: 'run_get', arguments: { ...args, detail: 'full' } }))
      expect(full).toMatchObject({ worktrees: [first], run: { executionLocation: run.executionLocation } })
      if ('detail' in full) throw new Error('Expected full Run details.')
      expect(full.executions.every(execution => execution.workingDirectory === first!.workingDirectory)).toBe(true)
      expect(f.dispatchErrors).toEqual([])
      const denied = await f.access.issue({ name: 'No Run reads', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [] })
      expect((await (await f.connect(denied.token)).callTool({ name: 'run_get', arguments: args })).isError).toBe(true)
      const reader = await f.access.issue({ name: 'Run reads without location', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { workspaceIds: [run.workspaceId] } }] })
      expect(result(await (await f.connect(reader.token)).callTool({ name: 'run_get', arguments: args })))
        .not.toHaveProperty('worktrees')
    } finally { await f.close() }
  }, 60000)
})
