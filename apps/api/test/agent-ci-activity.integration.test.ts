import { join } from 'node:path'
import { AgentReferenceManifestSchema, MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, CiGetOutputSchema, CiLogsOutputSchema, CiCancelOutputSchema, CiListOutputSchema, OperatorCiListInputSchema, CiRunOutputSchema, CiRunRecordSchema, CiTestsOutputSchema,
  type CiHostRun, type CiRunInput, type CiTestResults } from '@foreman-code/contracts'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { AcceptedRepeatStartV1Schema, RunActivitiesPageSchema, makeCurrentWorkflowFixture,
  type AcceptedRepeatStartV1, type CurrentFixtureForm } from '@foreman-code/contracts/wave25'
import { BugReportPageSchema } from '@foreman-code/contracts/management'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { buildApp } from '../src/app.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { databaseHotQueriesMigration } from '../src/infrastructure/databaseHotQueriesMigration.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { RepeatRepositoryFactory, repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { AgentReferenceService } from '../src/modules/files/references/agentService.js'
import { PostgresAgentReferenceAuthorization } from '../src/modules/files/references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from '../src/modules/files/references/agentProvenance.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { measuredCiPages } from './helpers/measuredCiPages.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { hostCiActivityMigration } from '../src/infrastructure/hostCiActivityMigration.js'
import { ciActivityRunLockMigration } from '../src/infrastructure/ciActivityRunLockMigration.js'
import { runActivityCommitLockMigration } from '../src/infrastructure/runActivityCommitLockMigration.js'
import { ciSharedActivityMigration } from '../src/infrastructure/ciSharedActivityMigration.js'
import { ciActivityRequesterLookupMigration } from '../src/infrastructure/ciActivityRequesterLookupMigration.js'
import { changeRunState, graphFixture, graphRpc, graphRpcValue, ownedGraph } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { acceptRunAuthority, bindRunAuthority } from '../src/modules/access/runAuthority.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'

async function admitCiRun(pool: pg.Pool, input: AcceptedRepeatStartV1, principal: ManagementPrincipal) {
  return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
    const client = sql as unknown as pg.PoolClient
    const authority = await acceptRunAuthority(client, principal)
    const accepted = AcceptedRepeatStartV1Schema.parse({
      run: { ...input.run, authorizationPrincipalId: authority.principal.id },
      snapshot: { ...input.snapshot, authorizationPrincipalId: authority.principal.id },
    })
    await insertRepeatRun(sql, accepted, repeatStartPublication)
    await bindRunAuthority(client, accepted.run.id, authority)
    return accepted
  }))
}

async function fixture(options: { deferMigration?: number | number[]; form?: CurrentFixtureForm;
  deniedCiReader?: boolean } = {}) {
  const database = await currentDatabase(options)
  const graph = await graphFixture(database, { form: options.form ?? 'single', qualifiedReads: true, insert: false,
    ...(options.deniedCiReader ? { nodeToolOverrides: [
      { add: [], remove: [] }, { add: [], remove: [] }, { add: [], remove: ['ci_get'] },
    ] } : {}) })
  graph.accepted = await admitCiRun(database.pool, graph.accepted, graph.writer.principal)
  graph.run = graph.accepted.run
  graph.f.run = graph.run
  await changeRunState(database, graph, 'running')
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executionId = randomUUID()
  const insertExecution = async (id: string, runId: string, executionNode = node) => database.pool.query(`insert into harness_executions
    (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
  [id, runId, executionNode.id, executionNode.agentId, JSON.stringify({ id, runId, workflowNodeId: executionNode.id,
    agentId: executionNode.agentId, attempt: 1,
    agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[executionNode.agentId],
    state: 'starting', input: {}, createdAt: graph.run.createdAt })])
  await ownedGraph(database, graph, async owner => {
    const locations = new WorkspaceLocationService(database.pool, graph.commands)
    const factory = new RepeatRepositoryFactory(locations, database.directory,
      createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services)
    const store = factory.forOwner(owner, graph.version)
    const admitted = await store.admit({ nodeId: node.id, occurrence: null }, () => HarnessExecutionSchema.parse({
      id: executionId, runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      state: 'queued', input: {}, createdAt: graph.run.createdAt,
    }))
    if (admitted.kind !== 'admitted') throw new Error('Expected the CI fixture execution to be admitted')
    const starting = await store.claimLaunch(executionId, {
      workingDirectory: database.directory,
      runtimeDirectory: repeatRuntimeDirectory(database.directory, graph.scope, admitted.execution),
    })
    if (!starting) throw new Error('Expected the CI fixture execution to start')
  })
  await database.pool.query(`update workspaces set record=record||$2::jsonb where id=$1`,
    [graph.scope.workspaceId, JSON.stringify({ repository: { provider: 'github', owner: 'example',
      name: 'project', defaultBranch: 'main' } })])
  let online = false
  // A Worker from before test results: its strict request schema rejects the flag that asks for them.
  let legacyWorker = false
  const computer: HostCiComputer = { key: 'synthetic-build', hostRef: { kind: 'main', mainId: randomUUID() },
    label: 'Build computer', priority: 1 }
  const hostRuns = new Map<string, CiHostRun>()
  const reported = new Map<string, CiTestResults>()
  const logs = new Map<string, string>()
  const endpoint: HostCiEndpoint = {
    computers: async () => online ? [computer] : [],
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, runs: [...hostRuns.values()] }
      if (request.operation === 'start') {
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        hostRuns.set(run.runId, run)
        return { operation: 'start', run }
      }
      const run = hostRuns.get(request.runId)!
      if (request.operation === 'cancel') {
        const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString() }
        hostRuns.set(run.runId, canceled)
        return { operation: 'cancel', run: canceled }
      }
      if (legacyWorker && 'testResults' in request) throw new Error('Unrecognized key: "testResults"')
      const tests = request.testResults && run.finishedAt ? reported.get(run.runId) : undefined
      const text = (logs.get(request.runId) ?? '').slice(request.afterOffset, request.afterOffset + request.maxBytes)
      return { operation: 'read', run, text, nextOffset: request.afterOffset + Buffer.byteLength(text),
        ...(tests ? { testResults: tests } : {}) }
    },
  }
  const ci = new HostCiService(database.pool, graph.commands, new RunCiAuthority(database.pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => 'a'.repeat(40),
  }, endpoint)
  const locations = new WorkspaceLocationService(database.pool, graph.commands)
  const runs = new RunManagementService(database.pool, graph.commands, {} as never, {} as never, locations)
  const credentials = new Wave25WorkerCredentialService(database.pool, graph.access)
  const worker = await credentials.issueForExecution(executionId)
  const bugReports = new BugReportService(database.pool, graph.commands)
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: { access: graph.access, commands: graph.commands,
      interactions: new PostgresAppInteractionService(database.pool, {} as never, graph.commands),
      bugReports },
    operator: { access: graph.access, services: { commands: graph.commands, workflows: graph.workflows, runs, ci, bugReports } as never } })
  app.decorate('agentReferenceService', new AgentReferenceService({
    files: new PostgresFileRepository(database.pool),
    bytes: new FileByteStorage(join(database.directory, 'reference-files'), MAX_FILE_BYTES),
    authorization: new PostgresAgentReferenceAuthorization(database.pool),
    reads: new PostgresReferenceReadRepository(database.pool),
  }))
  const reader = await graph.credential([{ actions: ['runs:read'], scope: { runIds: [graph.run.id] } }])
  const denied = await graph.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
  const request = { workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100 }
  async function call(token: string, name: string, args: Record<string, unknown>) {
    return graphRpc(app, token, 'tools/call', { name, arguments: args })
  }
  async function value(token: string, name: string, args: Record<string, unknown>) {
    const response = await call(token, name, args)
    expect(response.error).toBeUndefined()
    expect(response.result?.isError).not.toBe(true)
    return graphRpcValue(response.result)
  }
  const workerToken = worker.environment.variables.GRAPHQL_MCP_TOKEN!
  const submit = async (input: Partial<CiRunInput> = {}) => {
    const started = CiRunOutputSchema.parse(await value(workerToken, 'ci_run', {
      suite: 'integration', commandId: randomUUID(), ...input,
    }))
    await ci.dispatch()
    await ci.drain()
    return started
  }
  const activity = async (page: { cursor?: string; limit?: number } = {}) =>
    RunActivitiesPageSchema.parse(await value(reader.token, 'run_activities_get_v1', { ...request, ...page }))
  const boardInput = { workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId, runId: graph.run.id }
  const board = async () => RunBoardSnapshotGetResultSchema.parse(
    await value(reader.token, 'run_board_snapshot_get', boardInput))
  const get = async (ticketId: string) => {
    await ci.dispatch()
    await ci.drain()
    return CiGetOutputSchema.parse(await value(workerToken, 'ci_get', { ticketId }))
  }
  const finish = (ticketId: string, state: 'passed' | 'failed' | 'lost', tests?: CiTestResults) => {
    const run = hostRuns.get(ticketId)!
    if (tests) reported.set(ticketId, tests)
    hostRuns.set(ticketId, { ...run, state, exitCode: state === 'passed' ? 0 : 1,
      finishedAt: new Date().toISOString() })
  }
  return { database, graph, node, executionId, ci, app, reader, denied, request, boardInput, activity, board,
    submit, get, finish, call, value, workerToken, credentials, insertExecution, computer,
    online() { online = true },
    log(ticketId: string, text: string) {
      logs.set(ticketId, text)
      hostRuns.set(ticketId, { ...hostRuns.get(ticketId)!, logBytes: Buffer.byteLength(text) })
    },
    legacyWorker(value: boolean) { legacyWorker = value },
    async close() {
      await ci.close()
      await app.close()
      await graph.app.close()
      await database.close()
    } }
}

async function anotherWorkflow(f: Awaited<ReturnType<typeof fixture>>) {
  const created = (await f.graph.workflows.create(f.graph.writer.principal, 'mcp', {
    workspaceId: f.graph.scope.workspaceId, commandId: randomUUID(), name: 'Other CI workflow',
  })).value
  const definition = { ...f.graph.version.definition, id: created.workflow.id,
    createdAt: created.workflow.createdAt!, updatedAt: created.workflow.updatedAt! }
  delete definition.version
  const saved = (await f.graph.workflows.current.save(f.graph.writer.principal, 'mcp', {
    workspaceId: f.graph.scope.workspaceId, workflowId: created.workflow.id, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: f.graph.version.agentConfigurationVersionIds,
    graph: definition,
  })).value
  const next = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const foreign = await insertCurrentRunFixture(f.database.pool, { ...next, configurations: f.graph.f.configurations,
    run: { ...f.graph.f.run, id: next.run.id } }, saved, f.graph.writer.principal.id, { insert: false })
  const accepted = await admitCiRun(f.database.pool, foreign.accepted, f.graph.writer.principal)
  const admitted = { ...foreign, accepted, run: accepted.run }
  await changeRunState(f.database, { ...f.graph, ...admitted }, 'running')
  return admitted
}

const ciRef = (ticketId: string, executionId: string) => expect.objectContaining({ kind: 'ci', ticketId, executionId })

describe.skipIf(!postgresEnabled)('Agent Host CI in public Run activity', () => {
  afterEach(() => { vi.useRealTimers() })

  it.each(['same-run', 'another-run'] as const)(
    'reports shared CI for every requester in %s through MCP and Board activity', async location => {
      const f = await fixture({ form: 'parallel' })
      try {
        const ticket = await f.submit({ suite: 'install' })
        const other = location === 'same-run' ? f.graph : await anotherWorkflow(f)
        const joinedNode = agentWorkflowNode(other.version.definition.nodes[1])
        const joinedExecutionId = randomUUID()
        await f.insertExecution(joinedExecutionId, other.run.id, joinedNode)
        const credential = await f.credentials.issueForExecution(joinedExecutionId)
        const token = credential.environment.variables.GRAPHQL_MCP_TOKEN!
        const joined = CiRunOutputSchema.parse(await f.value(token, 'ci_run', {
          suite: 'install', commandId: randomUUID(),
        }))
        expect(joined).toMatchObject({ ticketId: ticket.ticketId, joined: true })
        const shared = CiGetOutputSchema.parse(await f.value(token, 'ci_get', { ticketId: ticket.ticketId }))
        expect(shared.sharing?.requesters.map(requester => requester.executionId).sort())
          .toEqual([f.executionId, joinedExecutionId].sort())
        const operator = await f.graph.credential([{ actions: [...CI_GET_ACTIONS, 'runs:read', 'bug_reports:read'],
          scope: { workspaceIds: [f.graph.scope.workspaceId] } }])
        const listInput = { workspaceId: other.scope.workspaceId, runId: other.run.id }
        expect(OperatorCiListInputSchema.safeParse(listInput).success).toBe(true)
        const listed = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list', listInput))
        expect(listed.jobs).toContainEqual(expect.objectContaining({ ticketId: ticket.ticketId,
          requester: expect.objectContaining({ executionId: joinedExecutionId }) }))
        const board = RunBoardSnapshotGetResultSchema.parse(await f.value(operator.token, 'run_board_snapshot_get', {
          workspaceId: other.scope.workspaceId, workflowId: other.scope.workflowId, runId: other.run.id,
        }))
        expect(board.activitySnapshot?.active).toContainEqual(expect.objectContaining({
          ref: ciRef(ticket.ticketId, joinedExecutionId),
        }))
        const scope = { workspaceId: other.scope.workspaceId, runId: other.run.id }
        const activities = async () => RunActivitiesPageSchema.parse(await f.value(operator.token,
          'run_activities_get_v1', scope))
        expect((await activities()).items).toContainEqual(expect.objectContaining({
          refs: expect.objectContaining({ ciTicketId: ticket.ticketId, executionId: joinedExecutionId }),
          ci: expect.objectContaining({ state: 'queued' }),
        }))
        f.online()
        await f.get(ticket.ticketId)
        f.finish(ticket.ticketId, 'passed')
        await f.get(ticket.ticketId)
        const events = (await activities()).items.filter(item => item.refs.ciTicketId === ticket.ticketId
          && item.refs.executionId === joinedExecutionId)
        expect(events.map(item => item.ci?.state)).toEqual(['queued', 'starting', 'running', 'passed'])
        const terminalBoard = RunBoardSnapshotGetResultSchema.parse(await f.value(operator.token,
          'run_board_snapshot_get', { workspaceId: other.scope.workspaceId,
            workflowId: other.scope.workflowId, runId: other.run.id }))
        const joinedActivities = terminalBoard.activitySnapshot?.activities.filter(item => item.owner.kind === 'ci' && item.owner.ticketId === ticket.ticketId
          && item.parent?.kind === 'execution' && item.parent.executionId === joinedExecutionId)
        expect(joinedActivities).toHaveLength(4)
        expect(joinedActivities!.every(item => item.owner.kind === 'ci'
          && item.owner.executionId === joinedExecutionId)).toBe(true)
        await f.database.pool.query(`update harness_executions set record=record||'{"state":"running"}'::jsonb
          where id=any($1::text[])`, [[f.executionId, joinedExecutionId]])
        const bugs = new BugReportService(f.database.pool, f.graph.commands)
        const idleMs = 3_600_000
        expect(await bugs.detectStuckExecutions(idleMs, new Date(Date.now() + 2 * idleMs))).toBe(2)
        const reports = BugReportPageSchema.parse(await f.value(operator.token, 'bug_reports_list', {
          workspaceId: f.graph.scope.workspaceId,
        }))
        expect(reports.items.map(report => report.id).sort()).toEqual([
          `bug-report-stuck-${f.executionId}`, `bug-report-stuck-${joinedExecutionId}`,
        ].sort())
        expect(reports.items.every(report => report.happened.message.includes('1 CI tickets'))).toBe(true)
        const denied = await f.call(f.denied.token, 'run_activities_get_v1', scope)
        expect(denied.error || denied.result?.isError).toBeTruthy()
      } finally { await f.close() }
    })

  it('lets another node read and cancel workspace CI tickets while a node without ci_get is denied', async () => {
    const f = await fixture({ form: 'parallel', deniedCiReader: true })
    try {
      f.online()
      const ticket = await f.submit({ suite: 'install' })
      f.finish(ticket.ticketId, 'passed')
      f.log(ticket.ticketId, 'Install completed\n')
      const original = (await f.get(ticket.ticketId)).run
      const readerNode = agentWorkflowNode(f.graph.version.definition.nodes[1])
      const readerExecutionId = randomUUID()
      await f.insertExecution(readerExecutionId, f.graph.run.id, readerNode)
      const reader = await f.credentials.issueForExecution(readerExecutionId)
      const readerToken = reader.environment.variables.GRAPHQL_MCP_TOKEN!
      const input = { ticketId: ticket.ticketId }
      const read = CiGetOutputSchema.parse(await f.value(readerToken, 'ci_get', input))
      expect(read.run).toEqual(original)
      expect(read.run.initiator.executionId).toBe(f.executionId)
      expect(CiLogsOutputSchema.parse(await f.value(readerToken, 'ci_logs_read', input)))
        .toMatchObject({ text: 'Install completed\n', nextOffset: 18 })
      const deniedNode = agentWorkflowNode(f.graph.version.definition.nodes[2])
      const deniedExecutionId = randomUUID()
      await f.insertExecution(deniedExecutionId, f.graph.run.id, deniedNode)
      const denied = await f.credentials.issueForExecution(deniedExecutionId)
      const deniedToken = denied.environment.variables.GRAPHQL_MCP_TOKEN!
      const catalog = await graphRpc(f.app, deniedToken, 'tools/list')
      expect(catalog.error).toBeUndefined()
      expect(catalog.result?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'files.references_list', 'files.reference_read',
      ]))
      expect(AgentReferenceManifestSchema.parse(await f.value(deniedToken, 'files.references_list', {})))
        .toMatchObject({ items: [], pageInfo: { nextCursor: null } })
      expect(catalog.result?.tools?.map(tool => tool.name)).not.toContain('ci_get')
      const blocked = await f.call(deniedToken, 'ci_get', input)
      expect(blocked.result?.isError).toBe(true)
      expect(graphRpcValue(blocked.result)).toMatchObject({ error: { code: 'TOOL_NOT_ENABLED' } })
      const ignoredWorkspace = CiGetOutputSchema.parse(await f.value(readerToken, 'ci_get', {
        ...input, workspaceId: 'other-workspace',
      }))
      expect(ignoredWorkspace.run).toEqual(original)
      const foreignWorkspaceId = randomUUID()
      const foreignTicketId = randomUUID()
      const foreign = CiRunRecordSchema.parse({ ...original, id: foreignTicketId,
        groupId: randomUUID(), workspaceId: foreignWorkspaceId })
      await f.database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
        [foreignWorkspaceId, JSON.stringify({ id: foreignWorkspaceId, name: 'Other CI workspace' })])
      await f.database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        values($1,$2,$3,$4,$5::jsonb)`,
      [foreign.id, foreign.workspaceId, foreign.groupId, foreign.state, JSON.stringify(foreign)])
      for (const tool of ['ci_get', 'ci_logs_read', 'ci_cancel']) {
        const outsideWorkspace = await f.call(readerToken, tool, { ticketId: foreignTicketId })
        expect(outsideWorkspace.result?.isError).toBe(true)
        expect(graphRpcValue(outsideWorkspace.result)).toMatchObject({ error: { code: 'CI_RUN_NOT_FOUND' } })
      }
      const persistedForeign = (await f.database.pool.query<{ record: unknown }>(
        'select record from ci_runs where id=$1', [foreignTicketId])).rows[0]!
      expect(CiRunRecordSchema.parse(persistedForeign.record)).toEqual(foreign)
      const waiting = await f.submit({ suite: 'install' })
      expect(CiCancelOutputSchema.parse(await f.value(readerToken, 'ci_cancel', { ticketId: waiting.ticketId })))
        .toMatchObject({ run: { id: waiting.ticketId, state: 'canceled' } })
      expect((await f.get(waiting.ticketId)).run.state).toBe('canceled')
    } finally { await f.close() }
  }, 120000)

  it('publishes queued, running and completed CI through authenticated MCP and HTTP with persisted readback', async () => {
    const f = await fixture()
    try {
      const deniedStart = await f.call(f.reader.token, 'ci_run', { workspaceId: f.request.workspaceId,
        suite: 'integration', commandId: randomUUID() })
      expect(deniedStart.error || deniedStart.result?.isError).toBeTruthy()
      expect((await f.database.pool.query('select count(*)::int as count from ci_runs')).rows[0]!.count).toBe(0)
      const ticket = await f.submit()
      const queued = await f.activity()
      expect(queued.items).toContainEqual(expect.objectContaining({ kind: 'job_work', status: 'queued',
        actor: expect.objectContaining({ agentId: f.node.agentId, nodeId: f.node.id }),
        refs: expect.objectContaining({ executionId: f.executionId, ciTicketId: ticket.ticketId }) }))
      const initialBoard = await f.board()
      expect(initialBoard.activitySnapshot?.queued).toContainEqual(ciRef(ticket.ticketId, f.executionId))
      expect(initialBoard.activitySnapshot?.active).toContainEqual(expect.objectContaining({
        ref: ciRef(ticket.ticketId, f.executionId), phase: 'waiting', ci: expect.objectContaining({ state: 'queued' }) }))
      f.online()
      const running = await f.get(ticket.ticketId)
      expect(running.run.state).toBe('running')
      expect((await f.board()).activitySnapshot?.active).toContainEqual(expect.objectContaining({
        ref: ciRef(ticket.ticketId, f.executionId), phase: 'active', evidence: 'confirmed',
        ci: expect.objectContaining({ state: 'running', computer: expect.objectContaining({ label: 'Build computer' }) }) }))
      f.finish(ticket.ticketId, 'passed')
      const done = await f.get(ticket.ticketId)
      const stored = (await f.database.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
        [ticket.ticketId])).rows[0]!
      expect(CiRunRecordSchema.parse(stored.record)).toEqual(done.run)
      const history = await f.activity()
      expect(history.items.filter(item => item.refs.ciTicketId === ticket.ticketId).map(item => item.ci?.state))
        .toEqual(['queued', 'starting', 'running', 'passed'])
      const finishedBoard = await f.board()
      expect(finishedBoard.snapshot).toEqual(initialBoard.snapshot)
      expect(finishedBoard.activitySnapshot?.active.some(work => work.ref.kind === 'ci')).toBe(false)
      expect(finishedBoard.activitySnapshot?.activities).toContainEqual(expect.objectContaining({
        owner: ciRef(ticket.ticketId, f.executionId), parent: expect.objectContaining({ executionId: f.executionId }),
        ci: expect.objectContaining({ state: 'passed', exitCode: 0 }) }))
      const headers = { authorization: `Bearer ${f.reader.token}` }
      const base = `/api/management/workspaces/${f.request.workspaceId}`
      const http = await f.app.inject({ method: 'GET', headers,
        url: `${base}/runs/${f.request.runId}/activities?limit=100` })
      expect(http.statusCode).toBe(200)
      expect(RunActivitiesPageSchema.parse(http.json())).toEqual(history)
      const boardHttp = await f.app.inject({ method: 'GET', headers,
        url: `${base}/workflows/${f.boardInput.workflowId}/runs/${f.request.runId}/snapshot` })
      expect(boardHttp.statusCode).toBe(200)
      expect(RunBoardSnapshotGetResultSchema.parse(boardHttp.json())).toEqual(finishedBoard)
      expect((await f.activity()).items).toEqual(history.items)
      for (const [tool, args] of [['run_activities_get_v1', f.request], ['run_board_snapshot_get', f.boardInput]] as const) {
        const blocked = await f.call(f.denied.token, tool, args)
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect(JSON.stringify(blocked)).not.toContain(ticket.ticketId)
      }
    } finally { await f.close() }
  }, 120000)

  it('keeps valid CI ticket links when neighboring activity has invalid ticket identifiers', async () => {
    const f = await fixture()
    try {
      const ticket = await f.submit()
      const initial = await f.activity()
      const linked = initial.items.filter(item => item.refs.ciTicketId === ticket.ticketId)
      expect(linked).toHaveLength(1)
      expect(linked[0]?.ci).toMatchObject({ id: ticket.ticketId, state: 'queued' })
      for (const ticketId of ['invalid-ticket', '', `{${ticket.ticketId}}`, null]) {
        await f.database.pool.query(`insert into run_activity
          (run_id,source,kind,harness_execution_id,occurred_at,payload)
          select run_id,source,kind,harness_execution_id,clock_timestamp(),
            jsonb_set(payload,'{ticketId}',$2::jsonb)
          from run_activity where run_id=$1 and payload->>'ticketId'=$3 order by sequence limit 1`,
        [f.request.runId, JSON.stringify(ticketId), ticket.ticketId])
      }
      const history = await f.activity()
      expect(history.items.filter(item => item.refs.ciTicketId === ticket.ticketId)).toEqual(linked)
      const http = await f.app.inject({ method: 'GET', headers: { authorization: `Bearer ${f.reader.token}` },
        url: `/api/management/workspaces/${f.request.workspaceId}/runs/${f.request.runId}/activities?limit=100` })
      expect(http.statusCode).toBe(200)
      expect(RunActivitiesPageSchema.parse(http.json())).toEqual(history)
    } finally { await f.close() }
  }, 120000)

  it('reads a Run’s CI activity without reading the workspace’s unrelated CI tickets', async () => {
    const f = await fixture()
    try {
      const ticket = await f.submit({ suite: 'install' })
      // Other Runs' finished tickets accumulate in the workspace: every full integration run adds a hundred.
      const unrelated = await f.database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,log_tail)
        select u.id,t.workspace_id,u.id,'canceled',t.record||jsonb_build_object('id',u.id::text,'groupId',u.id::text,
            'state','canceled','initiator',t.record->'initiator'||jsonb_build_object('executionId','unrelated-'||u.id::text)),
          (select string_agg(md5(u.id::text||g::text),'') from generate_series(1,40) g)
        from ci_runs t cross join (select gen_random_uuid() as id from generate_series(1,3000)) u where t.id=$1`,
      [ticket.ticketId])
      expect(unrelated.rowCount).toBe(3000)
      await f.database.pool.query('analyze ci_runs')
      const measured = measuredCiPages(f.database.pool)
      const runs = new RunManagementService(measured.pool, f.graph.commands, {} as never, {} as never,
        new WorkspaceLocationService(f.database.pool, f.graph.commands))
      const details = await runs.get(f.reader.principal, f.graph.scope.workspaceId, f.graph.run.id)
      expect(details.executions).toContainEqual(expect.objectContaining({ id: f.executionId, runId: f.graph.run.id }))
      expect(details.activitySnapshot?.queued).toContainEqual(ciRef(ticket.ticketId, f.executionId))
      // The unrelated tickets span hundreds of heap pages; the Run's own ticket needs a handful.
      expect(measured.pages.max).toBeLessThan(100)
    } finally { await f.close() }
  })

  it('lists a Run’s CI with the requesting Agent and filtered test results through MCP and HTTP', async () => {
    const f = await fixture()
    try {
      const ticket = await f.submit()
      f.online()
      expect((await f.get(ticket.ticketId)).run.state).toBe('running')
      const results: CiTestResults = { summary: { passed: 1, failed: 1, skipped: 1 }, truncated: false, files: [
        { file: 'apps/api/test/a.integration.test.ts', status: 'failed', durationMs: 900, tests: [
          { name: 'a rejects a stale revision', status: 'failed', durationMs: 400, message: 'expected 409 to be 200' },
          { name: 'a saves', status: 'passed', durationMs: 500 }] },
        { file: 'apps/api/test/b.integration.test.ts', status: 'skipped', durationMs: 5, tests: [
          { name: 'b waits for a computer', status: 'skipped', durationMs: null }] }] }
      f.finish(ticket.ticketId, 'failed', results)
      expect((await f.get(ticket.ticketId)).run.state).toBe('failed')
      const stored = (await f.database.pool.query<{ test_results: unknown }>('select test_results from ci_runs where id=$1',
        [ticket.ticketId])).rows[0]!
      expect(stored.test_results).toEqual(results)

      const workspaceId = f.request.workspaceId, runId = f.request.runId
      const operator = await f.graph.credential([{ actions: [...CI_GET_ACTIONS, 'runs:read'], scope: { workspaceIds: [workspaceId] } }])
      const listed = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list', { workspaceId, runId }))
      expect(listed).toEqual({ runId, truncated: false, jobs: [expect.objectContaining({
        ticketId: ticket.ticketId, scope: 'affected', placement: 'host', tests: results.summary,
        ci: expect.objectContaining({ id: ticket.ticketId, suite: 'integration', state: 'failed', exitCode: 1,
          computer: expect.objectContaining({ label: 'Build computer' }) }),
        requester: { executionId: f.executionId, agentId: f.node.agentId, nodeId: f.node.id,
          nodeName: f.node.name ?? f.node.label } })] })
      const failed = CiGetOutputSchema.parse(await f.value(operator.token, 'ci_get',
        { workspaceId, ticketId: ticket.ticketId, testStatus: ['failed'] }))
      expect(failed.tests).toEqual({ ...results, files: [{ ...results.files[0]!, tests: [results.files[0]!.tests[0]!] }] })
      const skippedOrPassed = CiGetOutputSchema.parse(await f.value(f.workerToken, 'ci_get',
        { ticketId: ticket.ticketId, testStatus: ['skipped', 'passed'] }))
      expect(skippedOrPassed.tests?.files.map(file => file.tests.map(test => test.name)))
        .toEqual([['a saves'], ['b waits for a computer']])
      expect(CiGetOutputSchema.parse(await f.value(operator.token, 'ci_get', { workspaceId, ticketId: ticket.ticketId }))
        .tests).toBeUndefined()

      const headers = { authorization: `Bearer ${operator.token}` }
      const base = `/api/management/workspaces/${workspaceId}/ci`
      const list = await f.app.inject({ method: 'GET', headers, url: `${base}?runId=${runId}` })
      expect(list.statusCode).toBe(200)
      expect(CiListOutputSchema.parse(list.json())).toEqual(listed)
      const tests = await f.app.inject({ method: 'GET', headers, url: `${base}/${ticket.ticketId}/tests?status=failed` })
      expect(tests.statusCode).toBe(200)
      expect(CiTestsOutputSchema.parse(tests.json())).toEqual({ ticketId: ticket.ticketId, tests: failed.tests })

      // A Run reader without CI grants, CI grants for another Run, and the requesting Agent itself are denied.
      const otherRun = await f.graph.credential([{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } },
        { actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
      for (const token of [f.reader.token, otherRun.token, f.workerToken]) {
        const blocked = await f.call(token, 'ci_list', { workspaceId, runId })
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect(JSON.stringify(blocked)).not.toContain(ticket.ticketId)
      }
      const deniedHttp = await f.app.inject({ method: 'GET', url: `${base}?runId=${runId}`,
        headers: { authorization: `Bearer ${otherRun.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      expect((await f.database.pool.query<{ count: number }>(`select count(*)::int as count from management_audit
        where principal_id=$1 and outcome='denied'`, [otherRun.principal.id])).rows[0]!.count).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 120000)

  it('filters an execution before bounding persisted CI tickets through HTTP and authenticated MCP', async () => {
    const f = await fixture()
    try {
      const ticket = await f.submit()
      const workspaceId = f.request.workspaceId
      const runId = f.request.runId
      const otherExecution = randomUUID()
      await f.database.pool.query(`insert into harness_executions
        (id,run_id,workflow_node_id,agent_id,attempt,record)
        select $1,run_id,workflow_node_id,agent_id,attempt+1,
          record||jsonb_build_object('id',$1::text,'attempt',attempt+1)
        from harness_executions where id=$2`, [otherExecution, f.executionId])
      const stored = (await f.database.pool.query<{ record: unknown }>(
        'select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]!
      const original = CiRunRecordSchema.parse(stored.record)
      const newer = Array.from({ length: 500 }, () => {
        const id = randomUUID()
        return { ...original, id, groupId: id,
          initiator: { ...original.initiator, executionId: otherExecution } }
      })
      await f.database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,created_at)
        select (record->>'id')::uuid,record->>'workspaceId',(record->>'groupId')::uuid,
          record->>'state',record,'2099-01-01T00:00:00Z'::timestamptz
        from jsonb_array_elements($1::jsonb) record`, [JSON.stringify(newer)])
      const operator = await f.graph.credential([{ actions: [...CI_GET_ACTIONS, 'runs:read'],
        scope: { workspaceIds: [workspaceId] } }])
      const unfiltered = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list', { workspaceId, runId }))
      expect(unfiltered.truncated).toBe(true)
      expect(unfiltered.jobs).toHaveLength(500)
      expect(unfiltered.jobs.some(job => job.ticketId === ticket.ticketId)).toBe(false)
      const input = { workspaceId, runId, executionId: f.executionId }
      const listed = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list', input))
      expect(listed.truncated).toBe(false)
      expect(listed.jobs.map(job => job.ticketId)).toEqual([ticket.ticketId])
      expect(listed.jobs[0]?.requester.executionId).toBe(f.executionId)
      const base = `/api/management/workspaces/${workspaceId}/ci`
      const headers = { authorization: `Bearer ${operator.token}` }
      const url = `${base}?runId=${runId}&executionId=${f.executionId}`
      const http = await f.app.inject({ method: 'GET', url, headers })
      expect(http.statusCode).toBe(200)
      expect(CiListOutputSchema.parse(http.json())).toEqual(listed)
      expect(CiRunRecordSchema.parse((await f.database.pool.query<{ record: unknown }>(
        'select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]!.record)).toEqual(original)
      const reread = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list', input))
      expect(reread).toEqual(listed)
      const unknown = CiListOutputSchema.parse(await f.value(operator.token, 'ci_list',
        { ...input, executionId: randomUUID() }))
      expect(unknown.jobs).toEqual([])
      const scopedReader = await f.graph.credential([{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } },
        { actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
      for (const token of [f.reader.token, scopedReader.token, f.workerToken]) {
        const blocked = await f.call(token, 'ci_list', input)
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect(JSON.stringify(blocked)).not.toContain(ticket.ticketId)
      }
      const denied = await f.app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${scopedReader.token}` } })
      expect(denied.statusCode).toBe(403)
    } finally { await f.close() }
  }, 120000)

  it('settles CI on a Worker from before test results and retries results that could not be saved', async () => {
    const f = await fixture()
    try {
      const results: CiTestResults = { summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false, files: [
        { file: 'apps/api/test/a.integration.test.ts', status: 'passed', durationMs: 5,
          tests: [{ name: 'a saves', status: 'passed', durationMs: 5 }] }] }
      const stored = async (ticketId: string) => (await f.database.pool.query<{ test_results: unknown }>(
        'select test_results from ci_runs where id=$1', [ticketId])).rows[0]!.test_results
      f.online()
      f.legacyWorker(true)
      const old = await f.submit()
      f.finish(old.ticketId, 'passed', results)
      expect((await f.get(old.ticketId)).run.state).toBe('passed')
      expect(await stored(old.ticketId)).toBeNull()

      f.legacyWorker(false)
      const ticket = await f.submit()
      await f.database.pool.query('alter table ci_runs add constraint ci_results_blocked check (test_results is null) not valid')
      f.finish(ticket.ticketId, 'passed', results)
      const pending = await f.get(ticket.ticketId)
      expect(pending.run).toMatchObject({ state: 'passed', exitCode: 0, collection: 'pending' })
      expect(await stored(ticket.ticketId)).toBeNull()
      expect((await f.board()).activitySnapshot?.active.some(work => work.ref.kind === 'ci')).toBe(false)
      await f.database.pool.query('alter table ci_runs drop constraint ci_results_blocked')
      // The failed collection backs off before the next attempt.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(pending.run.observation!.nextAttemptAt!) + 1)
      expect((await f.get(ticket.ticketId)).run).toMatchObject({
        state: 'passed', exitCode: 0, finishedAt: pending.run.finishedAt, collection: 'complete',
      })
      expect(await stored(ticket.ticketId)).toEqual(results)
      const readback = CiGetOutputSchema.parse(await f.value(f.workerToken, 'ci_get', {
        ticketId: ticket.ticketId, testStatus: ['passed'],
      }))
      expect(readback.tests).toEqual(results)
    } finally { await f.close() }
  }, 120000)

  it('keeps CI activity scoped to its workflow while other Runs can read and cancel workspace tickets', async () => {
    const f = await fixture()
    try {
      const split = await f.submit({ partitions: 2 })
      const parts = await f.submit({ suite: 'build' })
      expect(split.partitions).toHaveLength(2)
      expect(parts.partitions).toHaveLength(2)
      const queued = await f.activity()
      const splitGroup = (await f.get(split.ticketId)).run.groupId
      expect(queued.items.filter(item => item.ci?.groupId === splitGroup)
        .map(item => item.ci?.partition?.index).sort()).toEqual([0, 1])
      expect(queued.items.filter(item => parts.partitions!.some(part => part.ticketId === item.refs.ciTicketId))
        .map(item => item.ci?.part).sort()).toEqual(['build-api', 'build-other'])
      const foreign = await anotherWorkflow(f)
      const foreignExecutionId = randomUUID()
      await f.insertExecution(foreignExecutionId, foreign.run.id)
      const foreignCredential = await f.credentials.issueForExecution(foreignExecutionId)
      const token = foreignCredential.environment.variables.GRAPHQL_MCP_TOKEN!
      const foreignTicket = CiRunOutputSchema.parse(await f.value(token, 'ci_run', {
        suite: 'install', commandId: randomUUID() }))
      await f.ci.dispatch()
      const foreignPage = RunActivitiesPageSchema.parse(await f.value(f.graph.writer.token, 'run_activities_get_v1', {
        workspaceId: foreign.scope.workspaceId, runId: foreign.run.id }))
      expect(foreignPage.items.filter(item => item.ci).map(item => item.refs.ciTicketId)).toEqual([foreignTicket.ticketId])
      expect((await f.activity()).items.some(item => item.refs.ciTicketId === foreignTicket.ticketId)).toBe(false)
      const foreignBoard = RunBoardSnapshotGetResultSchema.parse(await f.value(f.graph.writer.token,
        'run_board_snapshot_get', { workspaceId: foreign.scope.workspaceId,
          workflowId: foreign.scope.workflowId, runId: foreign.run.id }))
      expect(foreignBoard.activitySnapshot?.active.filter(work => work.ref.kind === 'ci').map(work => work.ref))
        .toEqual([expect.objectContaining({ executionId: foreignExecutionId, ticketId: foreignTicket.ticketId })])
      const read = CiGetOutputSchema.parse(await f.value(token, 'ci_get', { ticketId: split.ticketId }))
      expect(read.run.initiator.executionId).toBe(f.executionId)
      const logs = CiLogsOutputSchema.parse(await f.value(token, 'ci_logs_read', {
        ticketId: split.ticketId, group: true,
      }))
      expect(logs.parts?.map(part => part.run.id).sort())
        .toEqual(split.partitions!.map(part => part.ticketId).sort())
      expect(CiCancelOutputSchema.parse(await f.value(token, 'ci_cancel', { ticketId: split.ticketId })))
        .toMatchObject({ run: { id: split.ticketId, state: 'canceled' } })
      expect((await f.get(split.ticketId)).run.state).toBe('canceled')
      await expect(f.database.pool.query(`update ci_runs set record=jsonb_set(record,
        '{initiator,executionId}',to_jsonb($2::text)) where id=$1`, [split.ticketId, foreignExecutionId]))
        .rejects.toThrow('CI run ownership cannot change')
      expect((await f.get(split.ticketId)).run.initiator.executionId).toBe(f.executionId)
    } finally { await f.close() }
  }, 120000)

  it.each(['passed', 'failed', 'lost', 'canceled'] as const)('retains the %s terminal result and queued cancellation', async terminal => {
    const f = await fixture()
    try {
      const waiting = await f.submit()
      await f.value(f.workerToken, 'ci_cancel', { ticketId: waiting.ticketId })
      expect((await f.activity()).items).toContainEqual(expect.objectContaining({ status: 'canceled',
        refs: expect.objectContaining({ ciTicketId: waiting.ticketId }) }))
      const ticket = await f.submit()
      f.online()
      await f.get(ticket.ticketId)
      if (terminal === 'canceled') await f.value(f.workerToken, 'ci_cancel', { ticketId: ticket.ticketId })
      else f.finish(ticket.ticketId, terminal)
      expect((await f.get(ticket.ticketId)).run.state).toBe(terminal)
      const events = (await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)
      expect(events.map(item => item.ci?.state)).toEqual(['queued', 'starting', 'running', terminal])
      expect(events.at(-1)?.status).toBe({ passed: 'completed', failed: 'failed', lost: 'unknown', canceled: 'canceled' }[terminal])
      expect((await f.board()).activitySnapshot?.active.some(work => work.ref.kind === 'ci')).toBe(false)
    } finally { await f.close() }
  }, 120000)

  it('allows independent same-Run CI writes and delivers each event once in commit order', async () => {
    const f = await fixture()
    const first = await f.database.pool.connect()
    const second = await f.database.pool.connect()
    try {
      const ticketA = await f.submit()
      const ticketB = await f.submit()
      const initial = await f.activity()
      const before = (await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence', [f.graph.run.id])).rows
      await beginTransaction(first)
      await beginTransaction(second)
      const canceledAt = new Date().toISOString()
      const cancel = `update ci_runs set state='canceled',record=record||jsonb_build_object(
        'state','canceled','finishedAt',$2::text) where id=$1`
      await first.query(cancel, [ticketA.ticketId, canceledAt])
      await second.query("select set_config('statement_timeout','500ms',true)")
      await second.query(cancel, [ticketB.ticketId, canceledAt])
      const during = await f.activity({ cursor: initial.nextCursor })
      expect(during.items).toEqual([])
      const uncommitted = (await f.database.pool.query<{ id: string; state: string }>(
        'select id::text,state from ci_runs where id=any($1::uuid[]) order by id',
        [[ticketA.ticketId, ticketB.ticketId]])).rows
      expect(uncommitted).toEqual([ticketA.ticketId, ticketB.ticketId].sort()
        .map(id => ({ id, state: 'queued' })))
      // Commit in reverse write order: a cursor must not consume the first writer's provisional identity.
      await commitTransaction(second)
      const afterFirstCommit = await f.activity({ cursor: during.nextCursor, limit: 1 })
      expect(afterFirstCommit.items).toMatchObject([{ status: 'canceled', refs: { ciTicketId: ticketB.ticketId } }])
      const beforeSecondCommit = await f.activity({ cursor: afterFirstCommit.nextCursor, limit: 1 })
      expect(beforeSecondCommit.items).toEqual([])
      await commitTransaction(first)
      const records = (await f.database.pool.query<{ record: unknown }>(
        'select record from ci_runs where id=any($1::uuid[])', [[ticketA.ticketId, ticketB.ticketId]])).rows
      expect(records.map(row => CiRunRecordSchema.parse(row.record))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ticketA.ticketId, state: 'canceled', finishedAt: canceledAt }),
        expect.objectContaining({ id: ticketB.ticketId, state: 'canceled', finishedAt: canceledAt }),
      ]))
      const afterSecondCommit = await f.activity({ cursor: beforeSecondCommit.nextCursor, limit: 1 })
      expect(afterSecondCommit.items).toMatchObject([{ status: 'canceled', refs: { ciTicketId: ticketA.ticketId } }])
      const delivered = [...afterFirstCommit.items, ...afterSecondCommit.items]
      expect(new Set(delivered.map(item => item.id)).size).toBe(2)
      expect(BigInt(delivered[1]!.sequence)).toBeGreaterThan(BigInt(delivered[0]!.sequence))
      expect((await f.activity({ cursor: afterSecondCommit.nextCursor })).items).toEqual([])
      expect((await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence limit $2',
        [f.graph.run.id, before.length])).rows).toEqual(before)
      const denied = await f.call(f.denied.token, 'run_activities_get_v1', { ...f.request, cursor: initial.nextCursor })
      expect(denied.error || denied.result?.isError).toBeTruthy()
    } finally {
      await rollbackTransaction(first)
      await rollbackTransaction(second)
      first.release()
      second.release()
      await f.close()
    }
  }, 120000)

  it('observes retained Host CI once without inventing earlier transitions', async () => {
    // Defer activity function replacements with the migrations that define those functions.
    const f = await fixture({ deferMigration: [hostCiActivityMigration.version, ciActivityRunLockMigration.version,
      databaseHotQueriesMigration.version, ciSharedActivityMigration.version, runActivityCommitLockMigration.version,
      ciActivityRequesterLookupMigration.version] })
    try {
      const ticket = await f.submit()
      expect((await f.activity()).items.filter(item => item.kind === 'job_work')).toEqual([])
      await applyApplicationMigrations(f.database.pool)
      const ci = (await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)
      expect(ci).toHaveLength(1)
      expect(ci[0]?.ci?.state).toBe('queued')
      await applyApplicationMigrations(f.database.pool)
      expect((await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)).toEqual(ci)
    } finally { await f.close() }
  }, 120000)
})
