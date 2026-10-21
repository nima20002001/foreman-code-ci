import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildProductionApp } from '../src/production.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { placementChoiceRequirements } from '../src/modules/placement/choicesService.js'

const fixture = makeCurrentWorkflowFixture('placement-discovery', 'single')
const mainId = randomUUID()
const input = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
  nodeId: fixture.version.definition.nodes[0]!.id, agentConfigurationVersionId: fixture.configurations[0]!.id }
const principal = ManagementPrincipalSchema.parse({ id: 'placement-reader', name: 'Placement reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [
    { actions: ['capabilities:read', 'harnesses:read'], scope: {} },
    { actions: ['workflows:read'], scope: { workspaceIds: [input.workspaceId], workflowIds: [input.workflowId] } },
    { actions: ['workspace_locations:read', 'source_roots:read', 'sources:read'], scope: { workspaceIds: [input.workspaceId] } },
  ] })
const choice = { id: 'approved-choice', label: 'Main approved root', availability: 'ready' as const, reason: null,
  placement: { schemaVersion: 1 as const, hostRef: { kind: 'main' as const, mainId }, rootPolicyId: 'root',
    rootPolicyRevision: '1', locationRevision: '1', projectRoot: '/approved/project', cwdPolicy: 'project-root' as const,
    relativeCwd: '', instanceId: 'profile', instanceRevision: '1', harnessInstallationId: 'installation' } }

let production: ReturnType<typeof buildProductionApp>
let address: string
let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
let liveGrants = principal.grants
let discover: MockInstance<ProductionPlacementChoiceDiscovery['list']>
let denied: MockInstance<PostgresCommandCoordinator['recordDenied']>

beforeEach(async () => {
  liveGrants = principal.grants
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/composition' })
  database = createDatabase(config.database)
  checkpoints = createCheckpointStore(config.database.connectionString, 'placement_composition', config.database)
  const query = vi.fn(async (sql: string) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('from management_principals')) return { rows: [{ id: principal.id, name: principal.name,
      audience: principal.audience, grants: liveGrants, expires_at: new Date(principal.expiresAt),
      revoked_at: null, delegated_from: null }], rowCount: 1 }
    if (sql.includes('from application_installation')) return { rows: [{ id: mainId }], rowCount: 1 }
    if (sql.startsWith('select v.record from workflows')) return { rows: [{ record: fixture.version }], rowCount: 1 }
    throw new Error(`Unexpected placement composition query: ${sql}`)
  })
  vi.spyOn(database.pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never)
  vi.spyOn(PostgresAccessService.prototype, 'authenticate').mockImplementation(async token => {
    if (token === 'workflow-only') return { ...principal, grants: [principal.grants[1]!] }
    if (token !== 'placement-reader') throw new DomainError('AUTH_REQUIRED', 'Authentication required.', 401)
    return principal
  })
  denied = vi.spyOn(PostgresCommandCoordinator.prototype, 'recordDenied').mockResolvedValue(undefined)
  discover = vi.spyOn(ProductionPlacementChoiceDiscovery.prototype, 'list').mockResolvedValue({ choices: [choice], pending: false })
  production = buildProductionApp(config, database, checkpoints, false)
  address = await production.app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await production.app.close()
  await production.engine.shutdown()
  await Promise.all([database.close(), checkpoints.close()])
  vi.restoreAllMocks()
})

const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/nodes/${input.nodeId}/placement-choices`
const headers = { authorization: 'Bearer placement-reader' }
async function rpc(method: string, params: unknown, token = 'placement-reader') {
  const response = await fetch(new URL('/mcp', address), { method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const raw = await response.text()
  expect(response.status, raw).toBe(200)
  const body = raw.startsWith('event:')
    ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
  return JSON.parse(body).result
}

it('serves saved-node choices through production HTTP and authenticated Operator MCP', async () => {
  const read = await production.app.inject({ method: 'GET',
    url: `${path}?agentConfigurationVersionId=${input.agentConfigurationVersionId}`, headers })
  expect(read.statusCode, read.body).toBe(200)
  expect(read.json()).toEqual({ ...input, choices: [choice], pending: false })
  expect(read.headers['cache-control']).toBe('private, no-store')
  expect(read.headers.vary).toBe('Authorization, Cookie')
  const result = await rpc('tools/call', { name: 'workflow_node_placement_choices', arguments: input })
  expect(result.isError).not.toBe(true)
  expect(decodeMcpToolResult(result)).toEqual(read.json())
  expect(discover).toHaveBeenCalledWith(principal, input, 'mcp')
  const tools = await rpc('tools/list', {})
  expect(tools.tools).toContainEqual(expect.objectContaining({ name: 'workflow_node_placement_choices',
    inputSchema: expect.objectContaining({ required: expect.arrayContaining(Object.keys(input)) }) }))
  const capabilities = await rpc('tools/call', { name: 'operator_get_capabilities', arguments: { detail: 'full',
    workspaceId: input.workspaceId, workflowId: input.workflowId,
  } })
  expect(decodeMcpToolResult(capabilities).tools).toContain('workflow_node_placement_choices')
  expect(decodeMcpToolResult(capabilities).requirements).toContainEqual(expect.objectContaining({
    name: 'workflow_node_placement_choices', actions: placementChoiceRequirements.map(item => item.action),
  }))
})

it('rejects a stale configuration, conflicting URL scope and unauthenticated reads before discovery', async () => {
  const stale = await production.app.inject({ method: 'GET', url: `${path}?agentConfigurationVersionId=unsaved`, headers })
  expect(stale.statusCode).toBe(409)
  expect(stale.json().error.code).toBe('PLACEMENT_CONFIGURATION_CONFLICT')
  const conflict = await production.app.inject({ method: 'GET',
    url: `${path}?agentConfigurationVersionId=${input.agentConfigurationVersionId}&workspaceId=foreign`, headers })
  expect(conflict.statusCode).toBe(400)
  const unauthenticated = await production.app.inject({ method: 'GET',
    url: `${path}?agentConfigurationVersionId=${input.agentConfigurationVersionId}`,
    headers: { authorization: 'Bearer invalid' } })
  expect(unauthenticated.statusCode).toBe(401)
  expect(discover).not.toHaveBeenCalled()
})

it('audits out-of-scope and live-revoked HTTP/MCP callers before returning paths', async () => {
  const foreign = { ...input, workflowId: 'foreign-workflow' }
  const result = await rpc('tools/call', { name: 'workflow_node_placement_choices', arguments: foreign })
  expect(result.isError).toBe(true)
  expect(denied).toHaveBeenCalledWith(principal.id, 'mcp', 'workflow_node_placement_choices', 'mcp:workflow_node_placement_choices')
  liveGrants = []
  const read = await production.app.inject({ method: 'GET',
    url: `${path}?agentConfigurationVersionId=${input.agentConfigurationVersionId}`, headers })
  expect(read.statusCode).toBe(403)
  const revoked = await rpc('tools/call', { name: 'workflow_node_placement_choices', arguments: input })
  expect(revoked.isError).toBe(true)
  expect(discover).not.toHaveBeenCalled()
})

it('hides the MCP choices tool from a reader without path grants and audits its denied invocation', async () => {
  const tools = await rpc('tools/list', {}, 'workflow-only')
  expect(tools.tools).not.toContainEqual(expect.objectContaining({ name: 'workflow_node_placement_choices' }))
  const result = await rpc('tools/call', { name: 'workflow_node_placement_choices', arguments: input }, 'workflow-only')
  expect(result.isError).toBe(true)
  expect(denied).toHaveBeenCalledWith(principal.id, 'mcp', 'workflow_node_placement_choices', 'mcp:workflow_node_placement_choices')
  expect(discover).not.toHaveBeenCalled()
})
