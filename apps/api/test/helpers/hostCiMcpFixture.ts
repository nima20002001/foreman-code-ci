import type { ManagementAction } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import type { CiIntegrationInventory } from '../../src/modules/ci-host/integrationParts.js'
import type { CiUnitInventory } from '../../src/modules/ci-host/parts.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../src/modules/jobs/ciAuthority.js'
import {
  HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint,
} from '../../src/modules/ci-host/service.js'
import { workerToolServices } from './workerMcpServices.js'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { DomainError } from '../../src/modules/errors.js'
import {
  AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { PostgresAppInteractionService } from '../../src/modules/interactions/app.js'
import {
  acceptRunAuthority, bindRunAuthority, currentOperatorAuthority,
} from '../../src/modules/access/runAuthority.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { migratedDatabase } from './migratedDatabase.js'
import { ciReadWhen } from './ciReadWhen.js'
import { onlyCiInfrastructure } from '../../src/modules/ci-host/priority.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

// Dispatch and learned timings are global; each case starts with an empty CI queue and history.
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

// CircleCI's Bash startup prepends its real package managers ahead of the fixture shims.
beforeEach(() => { vi.stubEnv('BASH_ENV', '') })
afterEach(() => { vi.unstubAllEnvs() })

/** Two build computers that answer the host CI protocol from memory; tests finish their runs. */
function fakeComputers(github: Record<string, boolean> = {}, cloud: boolean | { github: number; circleci: number } = false,
  hostSlots = 1, cloudSystemd = false, publishMirror?: HostCiEndpoint['publishMirror'],
  beforeStatus?: (computer: HostCiComputer) => Promise<void>) {
  const mainId = randomUUID()
  const computers: HostCiComputer[] = ['laptop', 'builder'].map((name, index) => ({ key: `${mainId}:${name}`,
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, label: name, priority: 60 - index }))
  const slots = typeof cloud === 'boolean' ? { github: Number(cloud), circleci: 0 } : cloud
  for (const provider of ['github', 'circleci'] as const) {
    for (let slot = 0; slot < slots[provider]; slot++) {
      computers.push({ key: `${mainId}:cloud:${provider}:${slot}`, hostRef: { kind: 'cloud', mainId, provider, slot },
        label: `${provider === 'github' ? 'GitHub Actions' : 'CircleCI'} ${slot + 1}`, priority: 30,
        userSystemd: { supported: cloudSystemd, reason: cloudSystemd ? null : 'Executor has no systemd user manager' } })
    }
  }
  const runs = new Map<string, { computer: string; run: CiHostRun; log: string; request: CiHostRequest
    durations?: Record<string, number> }>()
  const started: { computer: string; request: CiHostRequest }[] = []
  const endpoint: HostCiEndpoint = {
    ...(publishMirror ? { publishMirror } : {}),
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        await beforeStatus?.(computer)
        const active = [...runs.values()].filter(value => value.computer === computer.label
          && ['starting', 'running'].includes(value.run.state))
        return { operation: 'status', ready: github[computer.label] !== false, cpuCount: 16, memoryBytes: 14 * 2 ** 30,
          ...(computer.userSystemd ? { userSystemd: computer.userSystemd } : {}),
          slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : hostSlots, slotsUsed: active.length,
          reasons: github[computer.label] === false ? ['Log in to GitHub on this computer (gh auth login).'] : [],
          runs: [...runs.values()].filter(value => value.computer === computer.label).map(value => value.run) }
      }
      if (request.operation === 'start') {
        if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'circleci'
          && request.part === 'unit-other') {
          throw new DomainError('CI_CLOUD_UNAVAILABLE', 'CircleCI cannot run the Worker unit tests (no podman).', 409)
        }
        if (github[computer.label] === false) throw new DomainError('COMPUTER_GITHUB_REQUIRED', 'Log in to GitHub.', 409)
        const existing = runs.get(request.runId)
        if (existing) return { operation: 'start', run: existing.run }
        const activeCount = [...runs.values()].filter(value => value.computer === computer.label
          && value.run.state === 'running').length
        if (activeCount >= (computer.hostRef.kind === 'cloud' ? 1 : hostSlots)) {
          throw new DomainError('CI_HOST_BUSY', 'Busy.', 409)
        }
        const run: CiHostRun = { runId: request.runId, state: 'running', step: 'install', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        runs.set(request.runId, { computer: computer.label, run, log: '', request })
        started.push({ computer: computer.label, request })
        return { operation: 'start', run }
      }
      if (request.operation === 'cancel' && computer.hostRef.kind !== 'cloud' && !runs.has(request.runId)) {
        // HostCiRunner remembers Stop before admission and returns it to any delayed Start.
        const now = new Date().toISOString()
        const run: CiHostRun = { runId: request.runId, state: 'canceled', step: null, exitCode: null,
          startedAt: now, finishedAt: now, logBytes: 0, message: 'Canceled before execution.' }
        runs.set(request.runId, { computer: computer.label, run, log: '', request })
      }
      const entry = runs.get(request.runId)
      if (!entry) throw new DomainError('CI_RUN_UNKNOWN', 'Unknown run.', 404)
      if (request.operation === 'cancel') {
        entry.run = { ...entry.run, state: 'canceled', finishedAt: new Date().toISOString(), message: 'Canceled.' }
        return { operation: 'cancel', run: entry.run }
      }
      const text = entry.log.slice(request.afterOffset, request.afterOffset + request.maxBytes)
      const finished = !['starting', 'running'].includes(entry.run.state)
      const run = request.testResults && finished ? { ...entry.run, collection: 'complete' as const } : entry.run
      return { operation: 'read', run, text, nextOffset: request.afterOffset + Buffer.byteLength(text),
        ...(request.testResults && finished ? {
          testResults: { summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false },
        } : {}),
        ...(request.durations && finished && entry.durations ? { durations: entry.durations } : {}) }
    },
  }
  const finish = (runId: string, exitCode: number, log: string, durations?: Record<string, number>, message?: string) => {
    const entry = runs.get(runId)!
    entry.log = log
    if (durations) entry.durations = durations
    else delete entry.durations
    entry.run = { ...entry.run, state: exitCode === 0 ? 'passed' : 'failed', exitCode, step: entry.request.operation === 'start'
      ? entry.request.suite : null, message: message ?? null, finishedAt: new Date().toISOString(), logBytes: Buffer.byteLength(log) }
  }
  return { endpoint, started, finish, computers }
}

export async function fixture(options: { repository?: boolean; github?: Record<string, boolean>; unitInventory?: CiUnitInventory
  integrationInventory?: CiIntegrationInventory
  cloud?: boolean | { github: number; circleci: number }; agent?: boolean; hostSlots?: number; cloudSystemd?: boolean
  changedFiles?: string[]
  publishMirror?: HostCiEndpoint['publishMirror']
  beforeStatus?: (computer: HostCiComputer) => Promise<void>
  databasePool?: (databaseUrl: string) => pg.Pool
  supersession?: { branch(commit: string): string | null; isAncestor(ancestor: string, commit: string): boolean }
  repositoryRunner?: { commits: CiCommits; endpoint: HostCiEndpoint } } = {}) {
  const saved = options.agent ? makeCurrentWorkflowFixture(randomUUID()) : undefined
  if (saved) {
    saved.configurations = saved.configurations.map(configuration => ({ ...configuration,
      graphqlTools: ['context_get' as const, 'ci_run' as const, 'ci_get' as const, 'ci_logs_read' as const,
        'ci_computers_list' as const] }))
  }
  const runtime = saved ? await codexApprovalRuntime('user', { fixture: saved, database }) : undefined
  const ownedPool = options.databasePool?.(database.databaseUrl)
  const db = runtime?.db ?? { ...database, pool: ownedPool ?? database.pool }
  const access = runtime?.access ?? new PostgresAccessService(db.pool)
  const workspaceId = runtime?.f.scope.workspaceId ?? randomUUID()
  if (!runtime) {
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI workspace' })])
  }
  if (options.repository !== false) {
    await db.pool.query('update workspaces set record=record || $2::jsonb where id=$1',
      [workspaceId, JSON.stringify({
        repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
        ...(options.cloud ? { ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } } : {}),
      })])
  }
  const published: string[] = []
  const inventory = options.unitInventory
  const commits = options.repositoryRunner?.commits ?? {
    infrastructureOnly: async () => onlyCiInfrastructure(options.changedFiles ?? ['apps/web/src/App.tsx']),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    ...(options.integrationInventory ? { integrationInventory: async () => options.integrationInventory! } : {}),
    ...(inventory ? { unitInventory: async () => inventory } : {}),
    ...(options.supersession ? {
      branch: async (_repository: string, _defaultBranch: string, commit: string) => options.supersession!.branch(commit),
      isAncestor: async (_repository: string, ancestor: string, commit: string) =>
        options.supersession!.isAncestor(ancestor, commit),
    } : {}),
    resolve: async (_repository: string, _branch: string, commit: string | undefined) => {
    const resolved = commit ?? 'a'.repeat(40)
    published.push(resolved)
    return resolved
  } }
  const computers = fakeComputers(options.github, options.cloud, options.hostSlots, options.cloudSystemd,
    options.publishMirror, options.beforeStatus)
  const commands = new PostgresCommandCoordinator(db.pool)
  const tools = workerToolServices(db.pool, commands)
  const { bugReports } = tools
  const ci = new HostCiService(db.pool, commands, new RunCiAuthority(db.pool), commits,
    options.repositoryRunner?.endpoint ?? computers.endpoint)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: {
      commands, ci, bugReports,
    } as unknown as OperatorServices },
    ...(runtime ? { appMcp: tools.appMcp(access, new PostgresAppInteractionService(db.pool, runtime.repository, commands)) } : {}) })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const credential = (actions: ManagementAction[]) => access.issue({ name: 'CI HTTP caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
  const connect = async (actions: ManagementAction[], scope: Record<string, unknown> = { workspaceIds: [workspaceId] }) => {
    const issued = await access.issue({ name: 'CI Operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope }] })
    const client = new Client({ name: 'host-ci-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS, 'jobs:cancel'])
  const close = async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    await runtime?.close()
    await ownedPool?.end()
  }
  let agent: Client | undefined
  let connectAgent: (() => Promise<Client>) | undefined
  if (runtime) {
    try {
      await runtime.db.pool.query(`update management_principals set grants=grants || $2::jsonb where id=$1`,
        [runtime.authorizationPrincipalId, JSON.stringify([{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS],
          scope: { workspaceIds: [workspaceId] } }])])
      runtime.f.run = await withExclusiveGraphConnection(runtime.db.pool, connection => connection.transaction(async sql => {
        const client = sql as unknown as pg.PoolClient
        const owner = await currentOperatorAuthority(sql, runtime.authorizationPrincipalId)
        const authority = await acceptRunAuthority(client, owner.principal)
        const version = runtime.f.version
        const workflow = (await sql.query<{ revision: string }>(
          'select revision::text from workflows where id=$1', [version.workflowId])).rows[0]!
        const run = AcceptedWorkflowRunV3Schema.parse({ ...runtime.f.run, id: randomUUID(),
          authorizationPrincipalId: authority.principal.id })
        const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: {
          request: { workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
            executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(workflow.revision),
            expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
            expectedLocationRevision: run.executionLocation.locationRevision, input: run.input },
          authorizationPrincipalId: authority.principal.id,
          executable: { version, configurations: runtime.f.configurations },
          workflow: { id: version.workflowId, workspaceId, revision: Number(workflow.revision),
            currentVersionId: version.id, archived: false, definition: version.definition },
          workspace: { id: workspaceId, archived: false, location: run.executionLocation }, draft: null,
        } })
        const admitted = await insertRepeatRun(sql, accepted, repeatStartPublication)
        await bindRunAuthority(client, admitted.id, authority)
        return admitted
      }))
      runtime.f.scope.runId = runtime.f.run.id
      await runtime.engine.start(runtime.f.run.id)
      const [interaction] = await runtime.pending()
      if (!interaction) throw new Error('Expected an active Agent')
      connectAgent = async () => {
        const issued = await runtime.credentials.issueForExecution(interaction.executionId)
        const client = new Client({ name: 'ci-agent-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { requestInit: { headers: { authorization: `Bearer ${issued.environment.variables.GRAPHQL_MCP_TOKEN!}` } } }))
        return client
      }
      agent = await connectAgent()
    } catch (error) {
      await close()
      throw error
    }
  }
  const call = async (client: Client, name: string, input: Record<string, unknown>) => {
    // Drive the background refresh explicitly; polling itself only reads persisted state.
    if (name === 'ci_get') await ci.dispatch()
    return client.callTool({ name, arguments: { ...(client === agent ? {} : { workspaceId }), ...input } })
  }
  const value = async (client: Client, name: string, input: Record<string, unknown>) => {
    const result = await call(client, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const waitFor = (client: Client, ticketId: string, matches: Parameters<typeof ciReadWhen>[2]) =>
    ciReadWhen(db.pool, async () => CiGetOutputSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'ci_get', arguments: { workspaceId, ticketId },
    }))), matches)
  return { ...computers, ci, app, credential, workspaceId, operator, agent, waitFor,
    authorizationPrincipalId: runtime?.authorizationPrincipalId,
    connect, connectAgent, call, value, published, pool: db.pool, close }
}
