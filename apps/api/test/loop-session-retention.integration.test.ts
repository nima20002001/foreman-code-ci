import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedRunDetailsSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { closeCompletedWorkflowSources } from '../src/modules/sources/workflowCleanup.js'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'
import { seedRetainedSourceAttempt } from './helpers/retainedSourceAttempt.js'
import { fixtureGit } from './helpers/workspaceRepository.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.runIf(postgresEnabled)('loop node directory and native session retention through MCP', () => {
  it.each([
    { placed: false, discarded: false, cleanup: 'service' },
    { placed: false, discarded: false, cleanup: 'sweep' },
    { placed: false, discarded: false, cleanup: 'service-dirty' },
    { placed: false, discarded: false, cleanup: 'sweep-dirty' },
    { placed: false, discarded: true, cleanup: 'none' },
    { placed: true, discarded: false, cleanup: 'none' },
  ])('retains the native attempt and cleans up after Stop (placed=$placed, discarded=$discarded, cleanup=$cleanup)',
    async ({ placed, discarded, cleanup }) => {
    const dirty = cleanup.endsWith('-dirty')
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    fixture.version.approval = { handler: 'native' }
    fixture.version.definition.approval = { handler: 'native' }
    fixture.run.approval = { handler: 'native' }
    for (const [index, configuration] of fixture.configurations.entries()) {
      if (configuration.harness.harness !== 'codex') throw new Error('Expected Codex')
      configuration.harness.sandbox = 'read-only'
      configuration.harness.model = index === 0 ? 'loop-model' : 'worker-model'
      configuration.harness.advanced = { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' }
    }
    let discardedDirectory: string | undefined
    const f: Awaited<ReturnType<typeof sourceWorktreeMcpFixture>> = await sourceWorktreeMcpFixture({
      approvalNodeIds: [], fixture,
      beforePrepareExecution: async execution => {
        if (discarded && !discardedDirectory && execution.workflowNodeId === fixture.version.entryNodeId) {
          discardedDirectory = await seedRetainedSourceAttempt(f, execution)
        }
      },
    })
    try {
      const graph = structuredClone(f.saved.version.definition)
      graph.approval = { handler: 'native' }
      graph.defaultWorktree = { rootBinding: { rootId: f.root.binding.rootId,
        bindingRevision: f.root.binding.bindingRevision } }
      const node = graph.nodes[0]!
      if (node.kind === 'job') throw new Error('Expected an Agent')
      node.interval = { everySeconds: 10, prompt: 'Check this Run and remember earlier findings.' }
      if (!placed) delete node.placement
      const response = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, graph,
        executionSemanticsVersion: 3, expectedRevision: f.saved.revision,
        expectedWorkflowVersionId: f.saved.currentVersionId,
        expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
      } })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(response)).value
      const started = await f.client.callTool({ name: 'run_start', arguments: {
        ...f.input, workflowVersionId: saved.currentVersionId, expectedWorkflowRevision: saved.revision,
      } })
      expect(started.isError, JSON.stringify(started)).not.toBe(true)
      const runId = RunStartV3ResultSchema.parse(decodeMcpToolResult(started)).run.id
      const scope = { workspaceId: f.input.workspaceId, runId }
      const read = async () => {
        const result = await f.client.callTool({ name: 'run_get', arguments: { ...scope, detail: 'full' } })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return SavedRunDetailsSchema.parse(decodeMcpToolResult(result))
      }
      const turns = (details: Awaited<ReturnType<typeof read>>) => details.executions
        .filter(execution => execution.workflowNodeId === node.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      const initial = await readUntil(read, details => turns(details).some(turn => turn.state === 'completed'),
        { timeoutMs: 30_000, description: 'initial node completion' })
      const first = turns(initial)[0]!
      expect(first.nativeSessionId).toBeDefined()
      if (discarded) expect(first.workingDirectory).not.toBe(discardedDirectory)
      const retainedFile = join(first.workingDirectory!, 'monitoring-notes.txt')
      await writeFile(retainedFile, 'Already reported the deployment failure.\n')
      const checked = await readUntil(read, details => turns(details).filter(turn => turn.state === 'completed').length >= 3,
        { timeoutMs: 40_000, description: 'two completed loop turns' })
      const executions = turns(checked).filter(turn => turn.state === 'completed')
      const [original, ...loops] = executions
      expect(loops).toHaveLength(2)
      expect(loops.map(loop => loop.input)).toEqual([1, 2].map(index => expect.objectContaining({
        tick: { index, everySeconds: 10 } })))
      if (placed) {
        expect(new Set(executions.map(turn => turn.workingDirectory)).size).toBe(3)
        expect(new Set(executions.map(turn => turn.nativeSessionId)).size).toBe(3)
        expect(loops.every(loop => loop.sessionContinuation === undefined)).toBe(true)
      } else {
        expect(new Set(executions.map(turn => turn.workingDirectory)).size).toBe(1)
        expect(loops.map(loop => loop.nativeSessionId)).toEqual([original!.nativeSessionId, original!.nativeSessionId])
        expect(loops.map(loop => loop.sessionContinuation?.previousExecutionId))
          .toEqual([original!.id, loops[0]!.id])
        expect(await readFile(retainedFile, 'utf8')).toBe('Already reported the deployment failure.\n')
      }
      for (let index = 1; index < executions.length; index++) {
        expect(Date.parse(executions[index]!.startedAt!)).toBeGreaterThanOrEqual(
          Date.parse(executions[index - 1]!.finishedAt!))
      }
      expect(checked.executions.filter(execution => execution.workflowNodeId !== node.id)).toHaveLength(1)
      expect(checked.run.executionState).toBe('running')
      expect(f.base.dispatchErrors).toEqual([])
      const records = (await f.base.db.pool.query<{ record: unknown }>(
        'select record from source_execution_materializations where execution_id=any($1::text[])',
        [executions.map(execution => execution.id)])).rows.map(row => SourceMaterializationRecordSchema.parse(row.record))
      if (cleanup !== 'none') {
        if (!dirty) {
          fixtureGit(first.workingDirectory!, 'add', 'monitoring-notes.txt')
          fixtureGit(first.workingDirectory!, 'commit', '-qm', 'Retain monitoring notes')
        }
        for (const record of records) await f.production.sources.confirmClosed(record)
        await access(first.workingDirectory!)
        expect(await readFile(retainedFile, 'utf8')).toBe('Already reported the deployment failure.\n')
      }
      const denied = await f.base.access.issue({ name: 'Denied loop reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [] })
      expect((await (await f.connect(denied.token)).callTool({ name: 'run_get', arguments: scope })).isError).toBe(true)
      const stopped = await f.client.callTool({ name: 'run_stop', arguments: scope })
      expect(stopped.isError).not.toBe(true)
      const finished = await readUntil(read, details => details.run.executionState === 'completed',
        { timeoutMs: 10_000, description: 'loop Run stopped' })
      expect(finished.run.outcome).toBe('canceled')
      await f.base.engine.reconcile(error => { throw error })
      expect((await read()).executions).toHaveLength(finished.executions.length)
      expect(finished.executions.every(execution => execution.state === 'completed')).toBe(true)
      const clean = async () => {
        if (cleanup.startsWith('service')) {
          for (const record of records) await f.production.sources.confirmClosed(record)
        } else if (cleanup.startsWith('sweep')) {
          const errors: unknown[] = []
          await closeCompletedWorkflowSources(f.base.db.pool, f.production.sources, error => errors.push(error))
          expect(errors).toEqual([])
        }
      }
      await clean()
      if (dirty) {
        const deadlines = async () => (await f.base.db.pool.query<{ deadline: string }>(
          `select worktree_cleanup->>'nextAttemptAt' as deadline from source_execution_materializations
            where materialization_id=any($1::uuid[]) order by materialization_id`,
          [records.map(record => record.receipt.materializationId)])).rows.map(row => row.deadline)
        const retained = await deadlines()
        expect(retained).toHaveLength(records.length)
        expect(retained.every(deadline => Date.parse(deadline) > Date.now())).toBe(true)
        await access(first.workingDirectory!)
        expect(await readFile(retainedFile, 'utf8')).toBe('Already reported the deployment failure.\n')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 1000)
        for (let sweep = 0; sweep < 3; sweep++) await clean()
        expect(await deadlines()).toEqual(retained)
        fixtureGit(first.workingDirectory!, 'add', 'monitoring-notes.txt')
        fixtureGit(first.workingDirectory!, 'commit', '-qm', 'Retain monitoring notes')
        vi.setSystemTime(Math.max(...retained.map(deadline => Date.parse(deadline))) + 1)
        await clean()
      }
      if (cleanup !== 'none') {
        await expect(access(first.workingDirectory!)).rejects.toMatchObject({ code: 'ENOENT' })
        const storage = await f.base.db.pool.query<{ bytes: string | null }>(
          `select record#>>'{retainedSharedTree,bytes}' as bytes from source_storage_reservations
            where reservation_id=any($1::uuid[])`, [records.map(record => record.reservationId)])
        expect(storage.rows.every(row => row.bytes === '0' || row.bytes === null)).toBe(true)
      }
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  }, 120_000)
})
