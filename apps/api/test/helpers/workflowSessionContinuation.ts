import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { CanonicalRunGraphCurrentSchema, CANONICAL_RUN_GRAPH_MCP_TOOLS, WorkActivationInputSchema,
  makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { buildApp } from '../../src/app.js'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { DomainError } from '../../src/modules/errors.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { readCurrentRunDetails } from '../../src/modules/runs/currentRead.js'
import { RunInspectionService } from '../../src/modules/runs/inspection.js'
import { RunActivitiesService } from '../../src/modules/runs/activities.js'
import { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'
import { readWorkflowSessionContinuation } from '../../src/modules/runs/sessionContinuation.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './agentWorkflowFixture.js'
import { approvalResponse } from './approvalResponse.js'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { br1002At } from './wave25Br1002Cuts.js'
import { rejectableDeferred } from './deferred.js'
import { RunWorktrees } from '../../src/modules/runs/runWorktrees.js'
import { repeatRuntimeDirectory } from '../../src/modules/runs/repeatRepositoryHost.js'
import { systemGitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { gitFixtureEnvironment } from './gitFixture.js'

type Fixture = Awaited<ReturnType<typeof codexApprovalRuntime>>

async function fixture(worktrees: boolean) {
  const definition = makeCurrentWorkflowFixture(randomUUID())
  definition.version.definition.handoffs = { contractVersion: 1 }
  definition.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 8 }
  const entry = agentWorkflowNode(definition.version.definition.nodes[0])
  entry.choice = { outcomes: [{ outcome: 'delegate', target: {
    kind: 'edge', relationshipId: definition.version.definition.edges[0]!.id,
  } }] }
  let revision = 0
  const revisions = new Map<string, number>()
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, env: environment, encoding: 'utf8' }).trim()
  const files = new Map<string, { directory: string; head: string; contents: string }>()
  const observedFiles: Array<{ directory: string; head: string; contents: string }> = []
  let trees: RunWorktrees
  const f: Fixture = await codexApprovalRuntime('user', { fixture: definition,
    ...(worktrees ? { sandbox: 'workspace-write' as const,
      preparePlacementExecution: async (_owner, run, execution) => {
        const tree = (await trees.prepare(run, AbortSignal.timeout(30_000), execution.id))!
        return { workingDirectory: tree.workingDirectory,
          runtimeDirectory: repeatRuntimeDirectory(f.db.directory, { ...f.f.scope, executionSemanticsVersion: 3 }, execution),
          revalidate: () => trees.verify(tree) }
      } } : {}),
    async workflowOutput(executionId) {
      const execution = await f.runs.getExecution(executionId)
      if (!execution) throw new Error('Missing execution')
      if (worktrees) {
        const directory = execution.workingDirectory!
        const previous = files.get(execution.workflowNodeId)
        if (previous) {
          let contents: string
          try { contents = await readFile(join(directory, 'notes.txt'), 'utf8') }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            contents = 'missing'
          }
          observedFiles.push({ directory, head: git(directory, 'rev-parse', 'HEAD'), contents })
        } else {
          await writeFile(join(directory, 'committed.txt'), execution.workflowNodeId)
          git(directory, 'add', 'committed.txt')
          git(directory, 'commit', '-m', 'Agent work')
          const contents = `Uncommitted work for ${execution.workflowNodeId}`
          await writeFile(join(directory, 'notes.txt'), contents)
          files.set(execution.workflowNodeId, { directory, head: git(directory, 'rev-parse', 'HEAD'), contents })
        }
      }
      const work = WorkActivationInputSchema.parse(execution.input).work
      if (execution.workflowNodeId === definition.version.entryNodeId) {
        const value = revisions.get(executionId) ?? ++revision
        revisions.set(executionId, value)
        return JSON.stringify({ routing: work.kind === 'work_return' && work.returned.outcome === 'accepted'
          ? { kind: 'finish' } : { kind: 'request', outcome: 'delegate' },
        data: { latestDeliverable: { revision: value }, remainingFindings: [] } })
      }
      if (work.kind !== 'work_request') throw new Error('Expected work request')
      const value = Number((parseWorkHandoffResult(work.acceptedSourceResult).data.latestDeliverable as
        { revision: number }).revision)
      return JSON.stringify({ routing: { kind: 'return', requestId: work.request.requestId,
        outcome: value === 1 ? 'needs_changes' : 'accepted' },
      data: { latestDeliverable: { revision: value }, remainingFindings: value === 1 ? ['Fix the result'] : [] } })
    },
  })
  if (worktrees) {
    git(f.db.directory, 'init', '-b', 'main')
    await writeFile(join(f.db.directory, 'project.txt'), 'project')
    git(f.db.directory, 'add', 'project.txt')
    git(f.db.directory, 'commit', '-m', 'Project')
    trees = new RunWorktrees(f.db.pool, join(f.db.directory, 'managed'), systemGitWorktreePorts(environment))
  }
  return { ...f, files, observedFiles }
}

export async function assertWorkflowSessionContinuation({ restart, worktrees = false }: {
  restart: boolean; worktrees?: boolean
}) {
  const f = await fixture(worktrees)
  let runtime: ReturnType<Fixture['compose']> = f
  let app: ReturnType<typeof buildApp> | undefined
  const cut = rejectableDeferred<void>()
  const release = rejectableDeferred<void>()
  const route = RepeatRunRepository.prototype.admitWorkRequest
  let paused = false
  const pause = vi.spyOn(RepeatRunRepository.prototype, 'admitWorkRequest').mockImplementation(async function (
    this: RepeatRunRepository, ...args: Parameters<RepeatRunRepository['admitWorkRequest']>
  ) {
    if (restart && !paused) {
      paused = true
      cut.resolve()
      await release.promise
      throw new DomainError('ENGINE_RESTART', 'Restart between activations', 409)
    }
    return route.apply(this, args)
  })
  try {
    if (restart) {
      const starting = runtime.engine.start(f.f.run.id)
      const settled = Promise.allSettled([starting])
      await br1002At(cut.promise, starting)
      const closing = rejectableDeferred<void>()
      const closeForRestart = runtime.native.closeForRestart.bind(runtime.native)
      const close = vi.spyOn(runtime.native, 'closeForRestart').mockImplementation(() => {
        const task = closeForRestart()
        closing.resolve()
        return task
      })
      const shutdown = runtime.engine.shutdown()
      await closing.promise
      release.resolve()
      await shutdown
      await settled
      close.mockRestore()
      pause.mockRestore()
      runtime = f.compose(new ApprovalPostgresSaver(f.db.pool, undefined, { schema: f.db.schema }))
    }
    await runtime.engine.start(f.f.run.id)
    for (let index = 0; index < 2; index++) {
      const pending = await runtime.repository.list({ runId: f.f.run.id, status: 'pending', limit: 10 })
      const run = await runtime.runs.get(f.f.run.id)
      const states = (await f.db.pool.query(`select id,record->>'state' as state,
        record#>>'{result,error,code}' as error from harness_executions where run_id=$1`, [f.f.run.id])).rows
      expect(pending, JSON.stringify({ index, state: run?.executionState, error: run?.result?.error, states }))
        .toHaveLength(1)
      const interaction = pending[0]!
      const response = interaction.kind === 'work_direction'
        ? { interactionId: interaction.id, optionId: 'finish', expectedRevision: interaction.revision }
        : approvalResponse(interaction)
      await runtime.service.respond({ kind: 'user', principal: f.principal }, response)
      await runtime.engine.start(f.f.run.id)
    }
    expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    const executions = (await f.db.pool.query<{ record: unknown }>(
      'select record from harness_executions where run_id=$1 order by created_at,id', [f.f.run.id]))
      .rows.map(row => HarnessExecutionSchema.parse(row.record))
    expect(executions).toHaveLength(4)
    if (worktrees) {
      expect(f.observedFiles).toHaveLength(2)
      expect(f.observedFiles).toEqual(expect.arrayContaining([...f.files.values()]))
    }
    for (const node of f.f.version.definition.nodes) {
      const activations = executions.filter(execution => execution.workflowNodeId === node.id)
      expect(new Set(activations.map(execution => execution.nativeSessionId)).size).toBe(1)
      expect(new Set(activations.map(execution => execution.runtimeDirectory)).size).toBe(activations.length)
      expect(activations[0]!.sessionContinuation).toBeUndefined()
      for (let index = 1; index < activations.length; index++) {
        expect(activations[index]!.sessionContinuation?.previousExecutionId).toBe(activations[index - 1]!.id)
        const provider = f.providers.get(activations[index]!.id)!
        expect(provider.calls.some(call => call.method === 'thread/resume')).toBe(true)
        expect(provider.calls.some(call => call.method === 'thread/start')).toBe(false)
        expect(f.providers.get(activations[index - 1]!.id)!.closes).toContain(activations[index]!.nativeSessionId)
      }
    }
    const closures = (await f.db.pool.query<{ generation: string; closed: boolean }>(
      `select generation::text,closed_at is not null as closed from execution_native_closures
        where execution_id=any($1::text[])`, [executions.map(execution => execution.id)])).rows
    expect(closures).toHaveLength(4)
    expect(closures.every(closure => closure.closed)).toBe(true)
    expect(new Set(closures.map(closure => closure.generation)).size).toBe(4)
    const prompts = f.counts().prompts
    await runtime.engine.start(f.f.run.id)
    expect(f.counts().prompts).toBe(prompts)
    expect(prompts).toBe(4)

    const commands = new PostgresCommandCoordinator(f.db.pool)
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: f.access, services: {
        commands, runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
        runs: { get: (principal: ManagementPrincipal, workspaceId: string, runId: string) =>
          readCurrentRunDetails(f.db.pool, principal, workspaceId, runId),
          inspection: new RunInspectionService(f.db.pool), activities: new RunActivitiesService(f.db.pool) },
      } as unknown as OperatorServices } })
    await app.ready()
    const caller = await f.access.issue({ name: 'Session history reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read', 'workflows:read'],
        scope: { workspaceIds: [f.f.scope.workspaceId] } }] })
    const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
        scope: { workspaceIds: ['other-workspace'] } }] })
    const call = async (name: string, args: unknown) => {
      const reply = await graphRpc(app!, caller.token, 'tools/call', { name, arguments: args })
      expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
      return graphRpcValue(reply.result)
    }
    const scope = { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id }
    const continued = executions.find(execution => execution.sessionContinuation)!
    const previousExecutionId = continued.sessionContinuation!.previousExecutionId
    expect(await call('run_execution_get', { ...scope, executionId: continued.id })).toMatchObject({
      execution: { continuedFromExecutionId: previousExecutionId } })
    expect(await call('run_get', scope)).toMatchObject({ executions: expect.arrayContaining([
      expect.objectContaining({ id: continued.id, continuedFromExecutionId: previousExecutionId }),
    ]) })
    expect(await call('run_get', { ...scope, detail: 'full' })).toMatchObject({
      executions: expect.arrayContaining([expect.objectContaining({ id: continued.id,
        sessionContinuation: continued.sessionContinuation })]),
    })
    const graph = CanonicalRunGraphCurrentSchema.parse(await call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current,
      { protocolVersion: 1, scope: f.f.scope }))
    expect(graph.state.executions.find(execution => execution.identity.executionId === continued.id))
      .toMatchObject({ continuedFromExecutionId: previousExecutionId })
    expect(await call('run_activities_get_v1', { ...scope, limit: 100 }))
      .toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ refs: expect.objectContaining({ continuedFromExecutionId: previousExecutionId }) }),
      ]) })
    for (const name of ['run_get', 'run_execution_get']) {
      const reply = await graphRpc(app, denied.token, 'tools/call', { name,
        arguments: { ...scope, ...(name === 'run_execution_get' ? { executionId: continued.id } : {}) } })
      expect(reply.result?.isError).toBe(true)
    }

    const latest = executions.filter(execution => execution.workflowNodeId === continued.workflowNodeId).at(-1)!
    const candidate = HarnessExecutionSchema.parse({ ...latest, id: 'future-activation', state: 'starting',
      result: undefined, finishedAt: undefined, nativeSessionId: undefined, sessionContinuation: undefined })
    for (const change of [{}, { workingDirectory: '/different-root' },
      { agentConfigurationVersionId: 'different-configuration' }]) {
      const selected = await withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(sql =>
        readWorkflowSessionContinuation(sql, { ...candidate, ...change })))
      expect(selected?.previousExecutionId).toBe(Object.keys(change).length ? undefined : latest.id)
    }
  } finally {
    release.resolve()
    pause.mockRestore()
    await app?.close()
    await f.close()
  }
}
