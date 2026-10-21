import { workerToolServices } from './helpers/workerMcpServices.js'
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { credentialAuthority, assertWave25WorkerBinding } from '../src/modules/interactions/wave25/credentialAuthority.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'

/** Query rows only are synthetic. Use the current schemas and the actual
 * authority/binding predicates, including reviewer bootstrap validation. */
function authorityRow(form: 'sequential' | 'repeat' | 'approval' = 'sequential', attempt = 2) {
  const f = makeCurrentWorkflowFixture('retry-credentials', form)
  const version: WorkflowVersionV3 = f.version
  if (form === 'approval') {
    const approval = approvalFixture()
    f.configurations.forEach((configuration, index) => {
      configuration.harness = structuredClone(approval.configurations[index]!.harness)
    })
  }
  const identity = f.identities[0]!
  const execution = HarnessExecutionSchema.parse({
    id: `${identity.executionId}-attempt-${attempt}`, runId: f.run.id,
    workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt, input: {}, state: 'starting', createdAt: f.createdAt, startedAt: f.createdAt,
  })
  return {
    run: WorkflowRunV3Schema.parse({ ...f.run, executionState: 'running', startedAt: f.createdAt }),
    version, execution, configuration: f.configurations[0]!, configurations: f.configurations,
    attempt, stopped: false, execution_closed: false, native_reference: null as NativeSessionReference | null,
    finalized: false, generation: null as string | null, native_owner: null as string | null, budget_active: false,
  }
}
type AuthorityRow = ReturnType<typeof authorityRow>
function addJob(row: AuthorityRow) {
  const job = JobWorkflowNodeSchema.parse({ kind: 'job', id: 'credential-job-node', name: 'Build',
    jobDefinitionId: 'credential-job', jobDefinitionRevision: 1, jobDefinitionVersionId: 'credential-job-version' })
  row.version.definition.nodes.unshift(job)
  row.version.definition.executionPolicy!.maxNodeExecutions++
  return job
}
function nativeRow(form: 'sequential' | 'repeat' | 'approval' = 'sequential') {
  const row = authorityRow(form)
  row.execution.state = 'running'
  row.execution.nativeSessionId = `native-${row.execution.id}`
  row.native_reference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: row.execution.nativeSessionId }
  row.native_owner = row.execution.agentId; row.generation = '7'; row.budget_active = true
  return row
}
function bindingFor(row: AuthorityRow) {
  return { execution_id: row.execution.id, run_id: row.run.id, workspace_id: row.run.workspaceId,
    workflow_id: row.run.workflowId, agent_id: row.execution.agentId, purpose: 'workflow' as 'workflow' | 'reviewer',
    approval_review_job_id: null as string | null, approval_review_lease_fence: null as string | null,
    approval_native_session_id: row.execution.nativeSessionId ?? null, approval_connection_generation: row.generation,
    live: true, environment_variable: 'GRAPHQL_MCP_TOKEN', execution_semantics_version: 3 }
}
function database(row: AuthorityRow, binding = bindingFor(row), currentReviewLease = true, initialBinding = binding) {
  const query = vi.fn(async (text: string) => {
    if (text === 'select record from harness_executions where id=$1') return { rows: [{ record: row.execution }], rowCount: 1 }
    if (text.startsWith('select operation_id,execution_id,run_id,node_id') || text.startsWith('select record from execution_native_placements')) return { rows: [], rowCount: 0 }
    if (text.includes('e.workflow_node_id as node_id')) return { rows: [{ run: row.run, version: row.version,
      execution: row.execution, node_id: row.execution.workflowNodeId }], rowCount: 1 }
    if (text.includes('from worker_credential_bindings b')) return { rows: [initialBinding], rowCount: 1 }
    if (text.includes('from harness_executions e')) return { rows: [{ ...row, authority_binding: binding }], rowCount: 1 }
    if (text.includes('select record from agent_configuration_versions')) return {
      rows: row.configurations.map((record) => ({ record })), rowCount: row.configurations.length,
    }
    if (text.includes('select 1 from review_jobs')) return { rows: [], rowCount: currentReviewLease ? 1 : 0 }
    throw new Error(`Unexpected authority query: ${text}`)
  })
  return { query, sql: { query } as unknown as GraphSqlClient }
}

describe.each(['sequential', 'repeat'] as const)('ENG06 %s retry credential authority', (form) => {
  it.each([1, 2])('admits fresh credentials for persisted attempt %i before a session exists', async (attempt) => {
    const row = authorityRow(form, attempt), { sql, query } = database(row)
    addJob(row)
    await expect(credentialAuthority(sql, row.execution.id, 'workflow')).resolves.toMatchObject({
      execution: { id: row.execution.id, attempt }, canRespond: false, nativeSessionId: null, generation: null,
    })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('e.attempt'), [row.execution.id])
  })

  it('authenticates when session publication commits between credential reads', async () => {
    const row = nativeRow(form)
    const binding = bindingFor(row)
    const initialBinding = { ...binding, approval_native_session_id: null, approval_connection_generation: null }
    const { sql } = database(row, binding, true, initialBinding)
    await expect(assertWave25WorkerBinding(sql, 'startup-principal')).resolves.toBeUndefined()
  })

  it('denies credentials revoked between the initial lookup and authority read', async () => {
    const row = nativeRow(form)
    const binding = bindingFor(row)
    const { sql } = database(row, { ...binding, live: false }, true, binding)
    await expect(assertWave25WorkerBinding(sql, 'revoked-principal')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it.each(['running', 'waiting'] as const)('keeps attempt two eligible while %s in its exact session', async (state) => {
    const row = nativeRow(form); row.execution.state = state
    addJob(row)
    await expect(assertWave25WorkerBinding(database(row).sql, 'fresh-retry-principal')).resolves.toBeUndefined()
  })

  it.each([[1, 2], [2, 1], [2, 3]])('rejects JSON attempt %i paired with indexed attempt %i', async (recordAttempt, indexedAttempt) => {
    const row = authorityRow(form, recordAttempt); row.attempt = indexedAttempt
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'workflow')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('refuses native credentials for a Job node even with a neighboring Agent and valid native grant binding', async () => {
    const row = nativeRow(form), job = addJob(row)
    row.execution.workflowNodeId = job.id
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'workflow')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(assertWave25WorkerBinding(database(row).sql, 'job-native-principal')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })
})

describe('ENG06 retry credentials retain authority and native fences', () => {
  const denied: Array<[string, (row: AuthorityRow) => void]> = [
    ['Stop / Run credential closure', (row) => { row.stopped = true }],
    ['execution credential closure', (row) => { row.execution_closed = true }],
    ['completed workflow execution', (row) => { row.execution.state = 'completed'; row.execution.finishedAt = row.execution.createdAt; row.execution.result = { outcome: 'succeeded' } }],
    ['inactive native budget', (row) => { row.budget_active = false }],
    ['changed Run configuration pin', (row) => { row.run.agentConfigurationVersionIds[row.execution.agentId] = 'another-configuration' }],
    ['changed WorkflowVersion pin', (row) => { row.run.workflowVersionId = 'another-version' }],
    ['another native session', (row) => { row.native_reference!.nativeSessionId = 'another-session' }],
    ['another native owner', (row) => { row.native_owner = 'another-agent' }],
    ['missing native generation', (row) => { row.generation = null }],
  ]
  it.each(denied)('rejects attempt two with %s', async (_name, mutate) => {
    const row = nativeRow(); mutate(row)
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'workflow')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  const invalidBindings: Array<[string, (binding: ReturnType<typeof bindingFor>) => void]> = [
    ['revocation / expiry', (binding) => { binding.live = false }],
    ['another Run', (binding) => { binding.run_id = 'another-run' }],
    ['another workspace', (binding) => { binding.workspace_id = 'another-workspace' }],
    ['another workflow', (binding) => { binding.workflow_id = 'another-workflow' }],
    ['another Agent', (binding) => { binding.agent_id = 'another-agent' }],
    ['another native session', (binding) => { binding.approval_native_session_id = 'another-session' }],
    ['stale connection generation', (binding) => { binding.approval_connection_generation = '6' }],
  ]
  it.each(invalidBindings)('rejects a retry binding with %s', async (_name, mutate) => {
    const row = nativeRow(), binding = bindingFor(row); mutate(binding)
    await expect(assertWave25WorkerBinding(database(row, binding).sql, 'retry-principal')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('permits only a finalized successful designated retry to act as reviewer', async () => {
    const row = nativeRow('approval')
    addJob(row)
    row.execution.state = 'completed'; row.execution.finishedAt = row.execution.createdAt; row.execution.result = { outcome: 'succeeded' }; row.finalized = true
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'reviewer')).resolves.toMatchObject({
      execution: { attempt: 2 }, canRespond: true, nativeSessionId: row.execution.nativeSessionId, generation: '7',
    })
    // Workflow lifetime remains closed even though the separate reviewer purpose is eligible.
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'workflow')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    row.execution.result = { outcome: 'failed', error: { code: 'ORIGINAL_FAILURE', message: 'Original failure', retryable: true } }
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'reviewer')).rejects.toMatchObject({ code: 'REVIEWER_EXECUTION_NOT_READY' })
    row.execution.result = { outcome: 'succeeded' }; row.finalized = false
    await expect(credentialAuthority(database(row).sql, row.execution.id, 'reviewer')).rejects.toMatchObject({ code: 'REVIEWER_EXECUTION_NOT_READY' })
  })

  it('cannot reuse a reviewer lease from an earlier job generation on attempt two', async () => {
    const row = nativeRow('approval')
    row.execution.state = 'completed'; row.execution.finishedAt = row.execution.createdAt; row.execution.result = { outcome: 'succeeded' }; row.finalized = true
    const binding = bindingFor(row)
    binding.purpose = 'reviewer'; binding.approval_review_job_id = 'exact-review-job'; binding.approval_review_lease_fence = '2'
    await expect(assertWave25WorkerBinding(database(row, binding).sql, 'reviewer-principal')).resolves.toBeUndefined()
    const stale = database(row, binding, false)
    await expect(assertWave25WorkerBinding(stale.sql, 'reviewer-principal')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(stale.query).toHaveBeenCalledWith(expect.stringContaining('select 1 from review_jobs'),
      ['exact-review-job', row.execution.id, '2'])
  })

  it('discovers Agent review capability in a mixed workflow only with current live read/respond grants', async () => {
    const row = nativeRow('approval'); addJob(row)
    row.run.authorizationPrincipalId = 'accepted-author'
    row.run.executionLocation = { runnerId: 'local', rootPath: '/credential-fixture', locationRevision: 1,
      identityHash: `sha256:${'1'.repeat(64)}` }
    row.execution.state = 'completed'; row.execution.finishedAt = row.execution.createdAt
    row.execution.result = { outcome: 'succeeded' }; row.finalized = true
    const binding = bindingFor(row); binding.purpose = 'reviewer'
    const { query } = database(row, binding)
    const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool,
      {} as ConstructorParameters<typeof PostgresAppInteractionService>[1],
      {} as ConstructorParameters<typeof PostgresAppInteractionService>[2], { respond: vi.fn() })
    const principal: ManagementPrincipal = { id: 'current-reviewer', name: 'Reviewer', audience: 'worker',
      agentId: row.execution.agentId, revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z',
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: [row.run.workspaceId],
        workflowIds: [row.run.workflowId], runIds: [row.run.id] } }] }
    expect(await service.canRespond(principal)).toBe(true)
    query.mockClear()
    expect(await service.canRespond({ ...principal, grants: [] })).toBe(false)
    expect(query).not.toHaveBeenCalled()
    binding.live = false
    expect(await service.canRespond(principal)).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('e.workflow_node_id as node_id'))).toBe(false)
  })
})

it('starts a single-tool Coder MCP session across publication and denies revoked or invalid callers', async () => {
  const row = nativeRow()
  row.configuration.graphqlTools = ['context_get']
  row.configuration.nativeTools = { mcpServers: [], apps: false }
  const binding = bindingFor(row)
  const initialBinding = { ...binding, approval_native_session_id: null, approval_connection_generation: null }
  const stored = database(row, binding, true, initialBinding)
  const token = 'startup-unit-token'
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const pool = { query: async (text: string, values: unknown[]) => {
    if (text.includes('from management_principals where token_hash')) {
      const principal = { id: 'startup-principal', name: 'Coder', audience: 'worker', agent_id: row.execution.agentId,
        token_hash: tokenHash, expires_at: new Date('2099-01-01'), revoked_at: null,
        grants: [{ actions: ['interactions:read'], scope: { runIds: [row.run.id],
          workflowIds: [row.run.workflowId], workspaceIds: [row.run.workspaceId] } }] }
      return { rows: values[0] === tokenHash ? [principal] : [] }
    }
    if (text.startsWith('select 1 from worker_credential_bindings')) return { rows: [{}], rowCount: 1 }
    if (text.includes('from agent_conversation_credentials')) return { rows: [] }
    if (text.includes("c.record->>'productRole' as role")) {
      return { rows: [{ role: row.configuration.productRole, defaults: row.configuration.graphqlTools, override: null,
        harness: row.configuration.harness }] }
    }
    return stored.query(text)
  } } as unknown as pg.Pool
  const access = new PostgresAccessService(pool)
  const service = new PostgresAppInteractionService(pool, {} as never, {} as never)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: workerToolServices(pool, {} as never).appMcp(access, service) })
  const client = new Client({ name: 'startup-coder', version: '1' })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['context_get'])
    for (const caller of [token, 'invalid-token']) {
      binding.live = false
      const response = await app.inject({ method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${caller}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
      expect(response.statusCode).toBe(401)
    }
  } finally {
    await client.close()
    await app.close()
  }
})
