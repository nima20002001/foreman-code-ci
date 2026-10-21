import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { assertSettled, definitionUrl, editThrough, meaningfulInput, rpc, saveThrough,
  stageThrough, transports, versionCount } from './helpers/eng07SaveAdmission.testSupport.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'

for (const transport of transports) describe.skipIf(!postgresEnabled)(`Run worktree saves over ${transport}`, () => {
  it('saves a finished Run in its own worktree and blocks an unrelated execution directory', async () => {
    let worktrees: RunWorktrees
    let runtimeRoot: string
    const f = await currentOperatorIntegration({
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [],
      preparePlacementExecution: async (_owner, run, execution) => {
        const tree = await worktrees.prepare(run)
        if (!tree) throw new Error('Expected a Run worktree')
        return { workingDirectory: tree.workingDirectory,
          runtimeDirectory: repeatRuntimeDirectory(runtimeRoot, { workspaceId: run.workspaceId,
            workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id,
            executionSemanticsVersion: 3 }, execution),
          revalidate: () => worktrees.verify(tree) }
      },
    })
    try {
      const environment = gitFixtureEnvironment()
      const root = f.db.directory
      runtimeRoot = root
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment })
      git('init', '-b', 'main')
      await writeFile(join(root, 'project.txt'), 'Workspace project')
      git('add', 'project.txt')
      git('commit', '-m', 'Workspace project')
      worktrees = new RunWorktrees(f.db.pool, join(root, 'managed-worktrees'), systemGitWorktreePorts(environment))
      await f.engine.start(f.f.run.id)
      await assertSettled(f)
      const run = await f.runs.get(f.f.run.id)
      const executions = await readCurrentExecutions(f.runs, f.f.run.id)
      expect(executions).toHaveLength(1)
      const execution = executions[0]!
      const tree = await worktrees.prepare(AcceptedWorkflowRunV3Schema.parse(f.f.run))
      expect(execution.nativeSessionId).toBeDefined()
      expect(execution.workingDirectory).toBe(tree!.workingDirectory)
      expect(execution.workingDirectory).not.toBe(run!.executionLocation!.rootPath)
      const input = await meaningfulInput(f)
      const count = await versionCount(f)
      const denied = await f.access.issue({ name: 'Read-only save observer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read'], scope: {} }] })
      const reader = await f.connect(denied.token)
      expect((await reader.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })).isError).toBe(true)
      const saved = await saveThrough(f, transport, input)
      expect(await saveThrough(f, transport, input)).toEqual({ ...saved, replayed: true })
      expect(await versionCount(f)).toBe(count + 1)
      expect(saved.value.version.definition).toEqual({ ...input.graph,
        version: (input.graph.version ?? 0) + 1, updatedAt: expect.any(String) })
      const read = await rpc(f, CURRENT_WORKFLOW_TOOLS.saved, {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      })
      expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result)).version).toEqual(saved.value.version)
      expect(await f.runs.get(f.f.run.id)).toEqual(run)
      expect(await f.runs.getExecution(execution.id)).toEqual(execution)
      expect(await f.workflows.getVersion(run!.workflowVersionId)).toEqual(f.f.version)

      const nextInput = await meaningfulInput(f)
      agentWorkflowNode(nextInput.graph.nodes[0]).initialPrompt += ' / another edit'
      const stage = await stageThrough(f, transport, nextInput)
      expect(stage.intent.stops).toHaveLength(0)
      const unrelatedDirectory = join(root, 'unrelated-execution')
      expect(unrelatedDirectory).not.toBe(tree!.workingDirectory)
      expect(unrelatedDirectory).not.toBe(run!.executionLocation!.rootPath)
      await f.db.pool.query(`update harness_executions
        set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1`,
      [execution.id, unrelatedDirectory])
      try {
        if (transport === 'http') {
          const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(nextInput),
            headers: graphHeaders(f.writer.token), payload: nextInput })
          expect(reply.statusCode).toBe(409)
          expect(reply.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        } else {
          const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, nextInput)
          expect(reply.result.isError).toBe(true)
          expect(graphRpcValue(reply.result)).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        }
        const blocked = await editThrough(f, transport, stage.advance)
        expect(blocked.intent?.state).toBe('waiting')
        expect(blocked.intent?.saveAttempted).toBe(false)
        expect(blocked.current).toEqual([expect.objectContaining({ settled: false, nativePending: true })])
        expect(await versionCount(f)).toBe(count + 1)
        expect(await f.workflows.getVersion(saved.value.version.id)).toEqual(saved.value.version)
      } finally {
        await f.db.pool.query(`update harness_executions
          set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1`,
        [execution.id, execution.workingDirectory])
      }
      const advanced = await editThrough(f, transport, stage.advance)
      expect(advanced.intent?.state).toBe('saved')
      expect(advanced.current.every(item => item.settled && !item.nativePending)).toBe(true)
      expect(await versionCount(f)).toBe(count + 2)
      expect(await f.runs.get(f.f.run.id)).toEqual(run)
    } finally {
      await f.close()
    }
  }, 60000)
})
