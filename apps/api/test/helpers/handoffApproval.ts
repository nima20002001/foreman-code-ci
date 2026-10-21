import { workerToolServices } from './workerMcpServices.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { WorkActivationInputSchema, makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { buildApp } from '../../src/app.js'
import { DomainError } from '../../src/modules/errors.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../../src/modules/interactions/app.js'
import { assertOrchestratorGraphAuthority } from '../../src/modules/interactions/graphAuthority.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { deliverApproval } from '../../src/modules/interactions/wave25/service.js'
import { object } from '../../src/modules/harnesses/codexStdioTransport.js'
import { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { approvalResponse } from './approvalResponse.js'
import { br1002At } from './wave25Br1002Cuts.js'
import { agentWorkflowNode } from './agentWorkflowFixture.js'
import { rejectableDeferred } from './deferred.js'

type Fixture = Awaited<ReturnType<typeof codexApprovalRuntime>>
type Runtime = ReturnType<Fixture['compose']>

async function fixture() {
  const definition = makeCurrentWorkflowFixture(randomUUID())
  definition.version.definition.handoffs = { contractVersion: 1 }
  definition.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 8 }
  const entry = agentWorkflowNode(definition.version.definition.nodes[0])
  definition.configurations = definition.configurations.map(configuration => ({
    ...configuration,
    graphqlTools: ['context_get', 'interaction_list', 'interaction_get',
      ...(configuration.agentId === entry.agentId ? ['interaction_respond' as const] : [])],
  }))
  const edge = definition.version.definition.edges[0]!
  entry.choice = { outcomes: [{ outcome: 'delegate', target: { kind: 'edge', relationshipId: edge.id } }] }
  let revision = 0
  const revisions = new Map<string, number>()
  const runtime: Fixture = await codexApprovalRuntime('orchestrator', {
    fixture: definition,
    async workflowOutput(executionId) {
      const execution = await runtime.runs.getExecution(executionId)
      if (!execution) throw new Error('Missing admitted workflow execution')
      const work = WorkActivationInputSchema.parse(execution.input).work
      if (execution.workflowNodeId === definition.version.entryNodeId) {
        const value = revisions.get(executionId) ?? ++revision
        revisions.set(executionId, value)
        return JSON.stringify({ routing: { kind: 'request', outcome: 'delegate' },
          data: { latestDeliverable: { revision: value }, remainingFindings: [] } })
      }
      if (work.kind !== 'work_request') throw new Error('Expected the business request input')
      const source = parseWorkHandoffResult(work.acceptedSourceResult)
      const value = Number(object(source.data.latestDeliverable).revision)
      return JSON.stringify({ routing: { kind: 'return', requestId: work.request.requestId,
        outcome: value === 1 ? 'needs_changes' : 'accepted' },
      data: { latestDeliverable: { revision: value }, remainingFindings: value === 1 ? ['Revise the result'] : [] } })
    },
  })
  return runtime
}

async function reviewThroughMcp(f: Fixture, runtime: Runtime, origin: string, previousReviewerId?: string) {
  const pending = await runtime.repository.list({ runId: f.f.run.id, status: 'pending', limit: 100 })
  expect(pending, await runtimeDetails(f, runtime)).toHaveLength(1)
  const interaction = pending[0]!
  const reviewerId = interaction.approval.designatedOrchestratorAgentId!
  const job = await runtime.repository.coordination.findReviewJob(interaction.id, reviewerId)
  expect(job?.state).toBe('pending')
  const binding = await new PostgresRepeatReviewerBindings(f.db.pool).select(interaction, f.f.version.entryNodeId)
  if (previousReviewerId) {
    expect(binding.execution.id).not.toBe(previousReviewerId)
    const previousReviewer = await runtime.runs.getExecution(previousReviewerId)
    expect(previousReviewer?.nativeSessionId).toBe(binding.execution.nativeSessionId)
    await expect(assertOrchestratorGraphAuthority(f.db.pool, interaction, { executionId: previousReviewerId }))
      .rejects.toMatchObject({ code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  }
  await expect(assertOrchestratorGraphAuthority(f.db.pool, interaction,
    { nativeSessionId: binding.execution.nativeSessionId! })).resolves.toBeDefined()
  await expect(assertOrchestratorGraphAuthority(f.db.pool, interaction,
    { nativeSessionId: `unrelated-${interaction.id}` })).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  const live = rejectableDeferred<void>()
  const issuance = vi.spyOn(runtime.credentials, 'issueForReviewer')
  const append = runtime.repository.coordination.appendReviewNativeEvent.bind(runtime.repository.coordination)
  const capture = vi.spyOn(runtime.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    await append(...args)
    if (args[2]?.live && args[1].type === 'turn.started'
      && args[1].payload.turnId === args[0].providerTurnOrMessageId) {
      live.resolve()
    }
  })
  const dispatch = runtime.native.reviewers.dispatchNext(reviewerId, `handoff-review-${interaction.id}`)
  const settledDispatch = Promise.allSettled([dispatch])
  const clients: Client[] = []
  let completed = false
  let readOnlyPrincipalId: string | undefined
  try {
    await br1002At(live.promise, dispatch)
    const issued = issuance.mock.results.at(-1)
    if (issued?.type !== 'return') throw new Error('Dispatcher did not issue its reviewer credential')
    const credential = await issued.value
    async function connect(token: string) {
      const client = new Client({ name: 'handoff-approval-regression', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      clients.push(client)
      return client
    }
    const readOnlyCredential = await runtime.credentials.issueForReviewer(binding.execution.id)
    readOnlyPrincipalId = readOnlyCredential.principalId
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [readOnlyPrincipalId,
      JSON.stringify([{ actions: ['interactions:read'], scope: { workspaceIds: [f.f.run.workspaceId],
        workflowIds: [f.f.run.workflowId], runIds: [f.f.run.id] } }])])
    const denied = await connect(readOnlyCredential.environment.variables.GRAPHQL_MCP_TOKEN!)
    expect((await denied.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(false)
    const input = approvalResponse(interaction)
    await expect(denied.callTool({ name: 'interaction_respond', arguments: input })).rejects.toThrow('not found')
    expect((await runtime.repository.get(interaction.id))?.status).toBe('pending')
    await runtime.credentials.revoke({ principalId: readOnlyPrincipalId })
    readOnlyPrincipalId = undefined
    const client = await connect(credential.environment.variables.GRAPHQL_MCP_TOKEN!)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'bug_report', 'context_get', 'interaction_list', 'interaction_get', 'interaction_respond',
    ]))
    expect((await client.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(true)
    expect((await client.callTool({ name: 'interaction_respond', arguments: input })).isError).not.toBe(true)
    const stored = await runtime.repository.get(interaction.id)
    expect(stored).toMatchObject({ selectedOptionId: input.optionId, status: 'delivery_pending', deliveryState: 'pending' })
    const readback = await client.callTool({ name: 'interaction_get', arguments: { interactionId: interaction.id } })
    expect(readback.isError).not.toBe(true)
    expect(JSON.stringify(decodeMcpToolResult(readback))).toContain(input.optionId)
    expect(f.counts().responses).toBe(previousReviewerId ? 1 : 0)
    const provider = f.providers.get(binding.execution.id)!
    provider.completeReview(job!.correlationId, job!.nativeSessionId)
    await dispatch
    const delivered = await deliverApproval({ repository: runtime.repository, nativeRuntime: runtime.native }, interaction.id)
    expect(delivered.deliveryState).toBe('delivered')
    await runtime.engine.resumeInteraction(delivered)
    expect((await runtime.repository.coordination.findReviewJob(interaction.id, reviewerId))?.state).toBe('completed')
    completed = true
    return binding.execution.id
  } finally {
    for (const client of clients) await client.close()
    if (!completed) await runtime.native.reviewers.shutdown()
    await settledDispatch
    if (readOnlyPrincipalId) await runtime.credentials.revoke({ principalId: readOnlyPrincipalId })
    capture.mockRestore()
    issuance.mockRestore()
  }
}

async function runtimeDetails(f: Fixture, runtime: Runtime): Promise<string> {
  const run = await runtime.runs.get(f.f.run.id)
  const executions = (await f.db.pool.query('select record,accepted from harness_executions where run_id=$1',
    [f.f.run.id])).rows
  return JSON.stringify({ run, executions })
}

export async function runHandoffApproval({ restart }: { restart: boolean }): Promise<void> {
  const f = await fixture()
  let runtime: Runtime = f
  vi.spyOn(runtime.native.reviewers, 'reconcile').mockResolvedValue(undefined)
  const cut = rejectableDeferred<string>()
  const release = rejectableDeferred<void>()
  let stoppedAtCut = false
  const route = RepeatRunRepository.prototype.admitWorkRequest
  const pause = vi.spyOn(RepeatRunRepository.prototype, 'admitWorkRequest').mockImplementation(async function (
    this: RepeatRunRepository, ...args: Parameters<RepeatRunRepository['admitWorkRequest']>
  ) {
    if (restart && !stoppedAtCut) {
      stoppedAtCut = true
      cut.resolve(args[0])
      await release.promise
      throw new DomainError('ENGINE_RESTART', 'Restart after terminal acceptance', 409)
    }
    return route.apply(this, args)
  })
  let app: FastifyInstance | undefined
  let start: Promise<unknown> | undefined
  try {
    if (restart) {
      start = runtime.engine.start(f.f.run.id)
      const settledStart = Promise.allSettled([start])
      const executionId = await br1002At(cut.promise, start)
      expect((await f.db.pool.query('select execution_id from run_work_results where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ execution_id: executionId }])
      expect((await f.db.pool.query('select request_id from run_work_requests where run_id=$1', [f.f.run.id])).rows)
        .toEqual([])
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
      close.mockRestore()
      await settledStart
      pause.mockRestore()
      runtime = f.compose(new ApprovalPostgresSaver(f.db.pool, undefined, { schema: f.db.schema }))
      vi.spyOn(runtime.native.reviewers, 'reconcile').mockResolvedValue(undefined)
      await runtime.engine.resume(f.f.run.id)
      expect(f.counts().sessions, await runtimeDetails(f, runtime)).toBe(2)
    } else {
      pause.mockRestore()
      await runtime.engine.start(f.f.run.id)
    }
    const commands = new PostgresCommandCoordinator(f.db.pool)
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      appMcp: workerToolServices(f.db.pool, commands).appMcp(f.access,
        new PostgresAppInteractionService(f.db.pool, runtime.repository, commands, runtime.service)) })
    const origin = await app.listen({ host: 'localhost', port: 0 })
    const firstReviewerId = await reviewThroughMcp(f, runtime, origin)
    const secondReviewerId = await reviewThroughMcp(f, runtime, origin, firstReviewerId)
    expect(secondReviewerId).not.toBe(firstReviewerId)
    expect((await runtime.runs.get(f.f.run.id))).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    const details = await runtime.runs.getDetails(f.f.run.workspaceId, f.f.run.id)
    expect(details?.executions).toHaveLength(4)
    const sessionIds = new Set<string>()
    for (const node of f.f.version.definition.nodes) {
      const executions = details!.executions.filter((execution) => execution.workflowNodeId === node.id)
      expect(executions).toHaveLength(2)
      const original = executions.find((execution) => !execution.sessionContinuation)!
      const resumed = executions.find((execution) => execution.sessionContinuation)!
      expect(original).toMatchObject({ state: 'completed', nativeSessionId: expect.any(String) })
      expect(resumed).toMatchObject({
        state: 'completed',
        nativeSessionId: original.nativeSessionId,
        sessionContinuation: {
          previousExecutionId: original.id,
          session: { nativeSessionId: original.nativeSessionId },
        },
      })
      sessionIds.add(original.nativeSessionId!)
    }
    expect(sessionIds.size).toBe(2)
    expect(f.counts()).toEqual({ sessions: 2, prompts: 6, responses: 2 })
    const jobs = (await f.db.pool.query<{ execution_id: string; state: string }>(
      `select j.execution_id,j.state from review_jobs j join durable_interactions i on i.id=j.interaction_id
        where i.run_id=$1 order by j.execution_id`, [f.f.run.id])).rows
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.state === 'completed')).toBe(true)
    expect(jobs.map((job) => job.execution_id).sort()).toEqual([firstReviewerId, secondReviewerId].sort())
    for (let attempt = 0; attempt < 2; attempt++) await runtime.engine.reconcile(() => {
      throw new Error('Reconciliation failed after completed approvals')
    })
    expect(f.counts()).toEqual({ sessions: 2, prompts: 6, responses: 2 })
  } finally {
    release.resolve()
    pause.mockRestore()
    try {
      if (app) {
        app.server.closeIdleConnections()
        await app.close()
      }
    } finally {
      await f.close()
      if (start) await Promise.allSettled([start])
    }
  }
}
