import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AgentSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, type AgentConfigurationVersion, type GraphqlToolOverride } from '@foreman-code/contracts'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture, CANONICAL_RUN_GRAPH_ROUTES, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, type CurrentFixtureForm } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'

export type GraphTestDatabase = Awaited<ReturnType<typeof currentDatabase>>
export const privateCanary = 'ENG04-PRIVATE-INPUT-MUST-NOT-REACH-GRAPH'

/** Real current typed Create/Save + canonical Start-publication SQL fixture.
 * No native/public Start acceptance is claimed. Current authoring, authentication,
 * SQL receipts/audit and canonical publication are actual production services. */
export async function graphFixture(db: GraphTestDatabase, options: { insert?: boolean; qualifiedReads?: boolean;
  form?: CurrentFixtureForm; handoffs?: boolean; maxNodeExecutions?: number; intervalEverySeconds?: number;
  harness?: AgentConfigurationVersion['harness']; nodeToolOverrides?: GraphqlToolOverride[] } = {}) {
  const f = makeCurrentWorkflowFixture(randomUUID(), options.form ?? 'repeat')
  if (options.harness) {
    for (const configuration of f.configurations) configuration.harness = structuredClone(options.harness)
  }
  if (options.intervalEverySeconds !== undefined) {
    for (const node of f.version.definition.nodes) node.interval = { everySeconds: options.intervalEverySeconds }
    for (const configuration of f.configurations) {
      if (configuration.harness.harness !== 'codex') continue
      configuration.harness.advanced = {
        ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
        ...configuration.harness.advanced,
        approvalPolicy: 'never',
      }
    }
  }
  if (options.handoffs && f.version.definition.repeat) throw new Error('Handoff fixture requires a non-repeat form')
  await db.pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
    values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [f.scope.workspaceId,
  JSON.stringify({ id: f.scope.workspaceId, name: 'Current graph fixture' }),
  JSON.stringify({ runnerId: 'runner-local', rootPath: db.directory }), JSON.stringify({ fixture: true })])
  for (const config of f.configurations) {
    const agent = AgentSchema.parse({ id: config.agentId, name: 'Fixture Worker', productRole: config.productRole,
      harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
      harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
    await db.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [agent.id, f.scope.workspaceId, JSON.stringify(agent)])
    await db.pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
      [config.id, f.scope.workspaceId, config.agentId, JSON.stringify(config)])
    await db.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agent.id, config.id])
  }
  const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
  const credential = (grants: ManagementGrant[]) => access.issue({ name: 'Current graph fixture caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants })
  const writer = await credential([{ actions: ['capabilities:read'], scope: {} }, {
    actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: { workspaceIds: [f.scope.workspaceId] },
  }])
  const graph = new RunGraphReadService(db.pool, { qualifiedReads: options.qualifiedReads === true })
  const workflows = new WorkflowManagementService(db.pool, commands)
  const services = { commands, workflows, runGraph: graph } as unknown as OperatorServices
  const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  await app.ready()
  try {
    const created = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.scope.workspaceId}/workflows`,
      headers: graphHeaders(writer.token), payload: { workspaceId: f.scope.workspaceId, commandId: randomUUID(), name: 'Current graph' } })
    if (created.statusCode !== 201) throw new Error(`Current fixture Create failed: ${created.statusCode} ${created.body}`)
    const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
    const workflowId = managed.workflow.id
    const response = await app.inject({ method: 'PUT', url: `/api/management/workspaces/${f.scope.workspaceId}/workflows/${workflowId}/definition`,
      headers: graphHeaders(writer.token), payload: {
        workspaceId: f.scope.workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: managed.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
        // A fresh authorable workflow has no saved version yet. Preserve its
        // exact creation stamps; publication assigns the first immutable V3.
        graph: { ...f.version.definition,
          nodes: f.version.definition.nodes.map((node, index) => ({ ...node,
            ...(options.nodeToolOverrides?.[index] ? { graphqlTools: options.nodeToolOverrides[index] } : {}),
          })),
          ...(options.maxNodeExecutions === undefined ? {} : {
            executionPolicy: { ...f.version.definition.executionPolicy, maxNodeExecutions: options.maxNodeExecutions },
          }),
          ...(options.handoffs ? { handoffs: { contractVersion: 1 },
            edges: f.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })) } : {}),
          id: workflowId, version: managed.workflow.version,
          createdAt: managed.workflow.createdAt, updatedAt: managed.workflow.updatedAt },
      } })
    if (response.statusCode !== 200) throw new Error(`Current typed fixture Save failed: ${response.statusCode} ${response.body}`)
    const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
    const { version, run, accepted, scope } = await insertCurrentRunFixture(db.pool, { ...f, run: { ...f.run,
      workflowId, executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1,
        identityHash: `sha256:${'1'.repeat(64)}` } } }, saved, writer.principal.id,
    { insert: options.insert !== false, input: { canary: privateCanary } })
    const grantScope = { workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId] }
    const readRequest = { protocolVersion: 1, scope }
    return { f: { ...f, version, run, scope }, version, run, accepted, scope, grantScope, writer, credential,
      access, commands, workflows, repeat: graph, graph, app, readRequest }
  } catch (error) { await app.close(); throw error }
}
export type GraphFixture = Awaited<ReturnType<typeof graphFixture>>
export async function ownedGraph<T>(db: GraphTestDatabase, t: GraphFixture, work: (owner: RunOwnership) => Promise<T>): Promise<T> {
  const owner = await RunOwnership.acquire(db.pool, t.run.id, () => undefined)
  if (!owner) throw new Error('Disposable fixture Run already has an owner')
  try { return await work(owner) } finally { await owner.release() }
}
export async function changeRunState(db: GraphTestDatabase, t: GraphFixture, state: 'running' | 'waiting') {
  return ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
    const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
    await sql.query(`update runs set execution_state=$2,record=jsonb_set(record,'{executionState}',to_jsonb($2::text)) where id=$1`, [t.run.id, state])
    await publishRepeatRunStateLocked(publication, owner)
  }))
}
export async function graphPosition(db: GraphTestDatabase, t: GraphFixture) {
  return (await db.pool.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [t.run.id])).rows[0]!.head
}
export function graphUrl(t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string) {
  const route = CANONICAL_RUN_GRAPH_ROUTES[kind].replace(':workspaceId', t.scope.workspaceId)
    .replace(':workflowId', t.scope.workflowId).replace(':runId', t.scope.runId)
  const query = new URLSearchParams({ workflowVersionId: t.scope.workflowVersionId, executionSemanticsVersion: '3',
    ...(after === undefined ? {} : { afterSequence: after }) })
  return `${route}?${query}`
}
export function graphHeaders(token?: string) {
  return { host: 'localhost', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}
export interface RpcResult {
  tools?: { name: string }[]; isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[]
  nextCursor?: string
}
export interface RpcEnvelope { result?: RpcResult; error?: unknown }
const origins = new WeakMap<FastifyInstance, Promise<string>>()
export async function graphRpc(app: FastifyInstance, token: string, method: string,
  params: Record<string, unknown> = {}, requestId: string | number = 1): Promise<{ status: number } & RpcEnvelope> {
  let origin = origins.get(app)
  if (!origin) {
    const address = app.server.address()
    origin = address && typeof address !== 'string'
      ? Promise.resolve(`http://127.0.0.1:${address.port}`)
      : app.listen({ host: '127.0.0.1', port: 0 })
    origins.set(app, origin)
  }
  const response = await fetch(new URL('/mcp', await origin), { method: 'POST',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) })
  const text = await response.text()
  const message: RpcEnvelope = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n') : text)
  if (method === 'tools/list' && message.result?.nextCursor) {
    const page = await graphRpc(app, token, method, { ...params, cursor: message.result.nextCursor })
    if (page.error || !page.result) return page
    return { status: response.status, result: { ...page.result,
      tools: [...(message.result.tools ?? []), ...(page.result.tools ?? [])] } }
  }
  return { status: response.status, ...message }
}
export function graphRpcValue(result: {
  structuredContent?: unknown
  content?: readonly { type: string; text?: string | undefined }[] | undefined
} | undefined): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((item) => item.type === 'text')?.text
  return text === undefined ? undefined : JSON.parse(text)
}
