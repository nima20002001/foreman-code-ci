import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS, CANONICAL_RUN_GRAPH_ROUTES,
  CanonicalRunGraphReadCapabilitiesSchema, CURRENT_WORKFLOW_ROUTES,
  RepeatGraphPageV3Schema, RepeatGraphSnapshotV3Schema, reduceRepeatGraphPageV3,
  type CanonicalRunGraphScope,
} from '@foreman-code/contracts/wave25'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import {
  graphFixture, graphHeaders, graphRpc, graphRpcValue, changeRunState, ownedGraph,
  privateCanary, type GraphFixture, type GraphTestDatabase,
} from './eng04-graph-composition-fixture.js'

type Kind = 'current' | 'snapshot' | 'events'
const kinds = ['current', 'snapshot', 'events'] as const
function url(scope: CanonicalRunGraphScope, kind: Kind, after?: string) {
  return CANONICAL_RUN_GRAPH_ROUTES[kind].replace(':workspaceId', scope.workspaceId)
    .replace(':workflowId', scope.workflowId).replace(':runId', scope.runId)
    + '?' + new URLSearchParams({ workflowVersionId: scope.workflowVersionId,
      executionSemanticsVersion: String(scope.executionSemanticsVersion),
      ...(after === undefined ? {} : { afterSequence: after }) })
}

/** Opt-in, isolated PostgreSQL + real bearer HTTP and stateless Operator MCP.
 * The fixture saves via the authenticated typed writer and initializes through
 * repeatStartPublication. No native execution/admission qualification is claimed.
 */
describe.skipIf(!postgresEnabled)('ENG04-B primary canonical read qualification', () => {
  let db: GraphTestDatabase
  const fixtures: GraphFixture[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(qualifiedReads = true) {
    const t = await graphFixture(db, { qualifiedReads }); fixtures.push(t); return t
  }
  async function pair(t: GraphFixture, kind: Kind, token = t.writer.token, after?: string, scope = t.scope as CanonicalRunGraphScope) {
    const http = await t.app.inject({ method: 'GET', url: url(scope, kind, after), headers: graphHeaders(token) })
    const mcp = await graphRpc(t.app, token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind],
      arguments: { protocolVersion: 1, scope, ...(after === undefined ? {} : { afterSequence: after }) } })
    return { http, mcp, remote: graphRpcValue(mcp.result) }
  }
  async function equalRead(t: GraphFixture, kind: Kind, token = t.writer.token, after?: string) {
    const { http, mcp, remote } = await pair(t, kind, token, after)
    expect(http.statusCode, http.body).toBe(200)
    expect(mcp.status).toBe(200)
    expect(mcp.result?.isError).not.toBe(true)
    expect(remote).toEqual(http.json())
    expect(http.headers['cache-control']).toBe('private, no-store')
    expect(http.headers.vary).toBe('Authorization')
    for (const secret of [privateCanary, db.directory, t.writer.token, token, t.writer.principal.id]) {
      expect(http.body).not.toContain(secret)
      expect(JSON.stringify(remote)).not.toContain(secret)
    }
    return http.json()
  }

  it('advertises ONLY current persisted V3 reads separately from native runtime/edit gates', async () => {
    const t = await fixture()
    const response = await t.app.inject({ method: 'GET', url: CANONICAL_RUN_GRAPH_ROUTES.readCapabilities,
      headers: graphHeaders(t.writer.token) })
    expect(response.statusCode).toBe(200)
    const discovery = CanonicalRunGraphReadCapabilitiesSchema.parse(response.json())
    expect(discovery.readSemanticsVersions).toEqual([3])
    expect(discovery.semantics3).toEqual({ persistedReads: true, payload: 'metadata_only', runtimeAdmission: false, meaningfulEdit: false })
    const remote = await graphRpc(t.app, t.writer.token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS.readCapabilities, arguments: {} })
    expect(remote.result?.isError).not.toBe(true)
    expect(graphRpcValue(remote.result)).toEqual(discovery)
    const list = await graphRpc(t.app, t.writer.token, 'tools/list')
    expect(list.result?.tools?.map((tool) => tool.name)).toContain(CANONICAL_RUN_GRAPH_MCP_TOOLS.readCapabilities)
    const legacy = await t.app.inject({ method: 'GET', url: CANONICAL_RUN_GRAPH_ROUTES.capabilities, headers: graphHeaders(t.writer.token) })
    expect(CanonicalRunGraphReadCapabilitiesSchema.parse(legacy.json())).toEqual(discovery)
    const repeat = await t.app.inject({ method: 'GET', url: CURRENT_WORKFLOW_ROUTES.capabilities, headers: graphHeaders(t.writer.token) })
    expect(repeat.json()).toMatchObject({ executionSemanticsVersion: 3, repeatOptional: true, runtimeAdmission: false, meaningfulEdit: false })
  })

  it('keeps current reads closed unless explicitly composed', async () => {
    const t = await fixture(false)
    const response = await t.app.inject({ method: 'GET', url: CANONICAL_RUN_GRAPH_ROUTES.readCapabilities, headers: graphHeaders(t.writer.token) })
    expect(CanonicalRunGraphReadCapabilitiesSchema.parse(response.json())).toMatchObject({ readSemanticsVersions: [], semantics3: { persistedReads: false } })
    for (const kind of kinds) {
      const { http, mcp, remote } = await pair(t, kind, t.writer.token, kind === 'events' ? '0' : undefined)
      expect(http.json()).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
      expect(mcp.result?.isError).toBe(true)
      expect(remote).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
    }
  })

  it('authorizes an independent read-only caller during ownership and after the publishing caller is revoked', async () => {
    const t = await fixture()
    const reader = await t.credential([{ actions: ['capabilities:read'], scope: {} }, { actions: ['runs:read'], scope: {
      ...t.grantScope, runIds: [t.run.id],
    } }])
    await changeRunState(db, t, 'running')
    await ownedGraph(db, t, async () => {
      for (const kind of kinds) await equalRead(t, kind, reader.token, kind === 'events' ? '0' : undefined)
      await t.access.revoke(t.writer.principal.id)
      for (const kind of kinds) await equalRead(t, kind, reader.token, kind === 'events' ? '0' : undefined)
    })
    await equalRead(t, 'current', reader.token)
    const tools = await graphRpc(t.app, reader.token, 'tools/list')
    expect(tools.result?.tools?.map((tool) => tool.name)).not.toContain('repeat_update')
    expect(tools.result?.tools?.map((tool) => tool.name)).not.toContain('run_start')
  })

  it('checks every Run/workflow/version/semantics pin even for a broadly authorized reader', async () => {
    const t = await fixture(), other = await fixture()
    const reader = await t.credential([{ actions: ['runs:read'], scope: {} }])
    const wrongScopes: CanonicalRunGraphScope[] = [
      { ...t.scope, workspaceId: other.scope.workspaceId }, { ...t.scope, workflowId: other.scope.workflowId },
      { ...t.scope, workflowVersionId: other.scope.workflowVersionId }, { ...t.scope, runId: other.scope.runId },
    ]
    for (const scope of wrongScopes) for (const kind of kinds) {
      const { http, mcp, remote } = await pair(t, kind, reader.token, kind === 'events' ? '0' : undefined, scope)
      expect(http.json()).toMatchObject({ error: { code: 'GRAPH_SCOPE_MISMATCH' } })
      expect(mcp.result?.isError).toBe(true)
      expect(remote).toMatchObject({ error: { code: 'GRAPH_SCOPE_MISMATCH' } })
      expect(http.body).not.toContain(privateCanary)
    }
    const absent = await pair(t, 'snapshot', reader.token, undefined, { ...t.scope, runId: `missing-${randomUUID()}` })
    expect(absent.http.json()).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
    expect(absent.remote).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
    for (const semantics of [1, 2, 4, '3', null]) {
      const response = await graphRpc(t.app, reader.token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot,
        arguments: { protocolVersion: 1, scope: { ...t.scope, executionSemanticsVersion: semantics } } })
      expect(response.error !== undefined || response.result?.isError === true).toBe(true)
    }
  })

  it('returns complete persisted batches, equal reset/retention readback and no synthetic replacement head', async () => {
    const t = await fixture()
    const initial = RepeatGraphSnapshotV3Schema.parse(await equalRead(t, 'snapshot'))
    await changeRunState(db, t, 'running')
    await changeRunState(db, t, 'waiting')
    const page = RepeatGraphPageV3Schema.parse(await equalRead(t, 'events', t.writer.token, initial.asOfSequence))
    const latest = RepeatGraphSnapshotV3Schema.parse(await equalRead(t, 'snapshot'))
    expect(reduceRepeatGraphPageV3(initial, page)).toEqual(latest)
    const sources = async () => (await db.pool.query('select * from run_graph_sources where run_id=$1 order by source_kind,source_id,source_revision', [t.run.id])).rows
    const permanent = await sources()
    const heads = await db.pool.query('select count(*)::text as n from run_graph_heads where run_id=$1', [t.run.id])
    expect(heads.rows[0]?.n).toBe('1')
    // Retention deletes only already-published batches under the canonical head
    // lock. It does not create a head, source receipt, workflow or admission.
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      await sql.query('select run_id from run_graph_heads where run_id=$1 for update', [t.run.id])
      await sql.query('update run_graph_heads set retention_floor=$2::bigint where run_id=$1', [t.run.id, latest.asOfSequence])
      await sql.query('delete from run_graph_batches where run_id=$1 and sequence<=$2::bigint', [t.run.id, latest.asOfSequence])
    }))
    expect(await equalRead(t, 'events', t.writer.token, initial.asOfSequence)).toMatchObject({ kind: 'reset', reason: 'history_expired',
      headSequence: latest.asOfSequence, retentionFloor: latest.asOfSequence, action: 'fetch_snapshot' })
    expect(await equalRead(t, 'events', t.writer.token, String(BigInt(latest.asOfSequence) + 1n)))
      .toMatchObject({ kind: 'reset', reason: 'cursor_ahead', action: 'fetch_snapshot' })
    expect(await equalRead(t, 'events', t.writer.token, latest.asOfSequence)).toMatchObject({ kind: 'page', batches: [], hasMore: false })
    expect(await equalRead(t, 'snapshot')).toEqual({ ...latest, retentionFloor: latest.asOfSequence })
    await equalRead(t, 'current')
    expect(await sources()).toEqual(permanent)
    expect((await db.pool.query('select count(*)::text as n from run_graph_heads where run_id=$1', [t.run.id])).rows).toEqual(heads.rows)
  })

  it('rejects an unjournaled domain cut on current, snapshot, empty delta and reset instead of trusting a head', async () => {
    const t = await fixture()
    const initial = RepeatGraphSnapshotV3Schema.parse(await equalRead(t, 'snapshot'))
    // Adversarial missing-publication regression, not an alternate producer.
    // No receipt is forged and no trigger or security boundary is disabled.
    await db.pool.query(`update runs set execution_state='waiting',record=jsonb_set(record,'{executionState}','"waiting"'::jsonb) where id=$1`, [t.run.id])
    for (const [kind, after] of [['current', undefined], ['snapshot', undefined], ['events', initial.asOfSequence],
      ['events', String(BigInt(initial.asOfSequence) + 1n)]] as const) {
      const { http, mcp, remote } = await pair(t, kind, t.writer.token, after)
      expect(http.json()).toMatchObject({ error: { code: 'GRAPH_INVARIANT_VIOLATION' } })
      expect(mcp.result?.isError).toBe(true)
      expect(remote).toMatchObject({ error: { code: 'GRAPH_INVARIANT_VIOLATION' } })
      expect(http.body).not.toContain(privateCanary)
    }
  })

  it('audits denied, wrong-scope and revoked callers on both authenticated transports', async () => {
    const t = await fixture()
    const wrong = await t.credential([{ actions: ['runs:read'], scope: { ...t.grantScope, runIds: ['another-run'] } }])
    const noRead = await t.credential([{ actions: ['capabilities:read'], scope: {} }])
    for (const caller of [wrong, noRead]) {
      for (const kind of kinds) {
        const { http, mcp, remote } = await pair(t, kind, caller.token, kind === 'events' ? '0' : undefined)
        expect(http.statusCode).toBe(403)
        expect(http.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        expect(mcp.result?.isError).toBe(true)
        expect(remote).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
      }
      const audit = (await db.pool.query('select source,outcome from management_audit where principal_id=$1', [caller.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'http', outcome: 'denied' }),
        expect.objectContaining({ source: 'mcp', outcome: 'denied' })]))
    }
    // Authentication cannot attach the revoked principal. Verify the anonymous
    // denial rows by source/target, not by inventing a successfully authenticated id.
    const denialCount = async (source: string, target: string) => Number((await db.pool.query(
      `select count(*)::text as n from management_audit where principal_id is null and source=$1 and target_key=$2 and outcome='denied'`,
      [source, target])).rows[0]!.n)
    const target = url(t.scope, 'snapshot').split('?')[0]!
    const beforeHttp = await denialCount('http', target), beforeMcp = await denialCount('mcp', '/mcp')
    await t.access.revoke(t.writer.principal.id)
    const denied = await pair(t, 'snapshot')
    expect(denied.http.statusCode).toBe(401)
    expect(denied.mcp.status).toBe(401)
    expect(await denialCount('http', target)).toBe(beforeHttp + 1)
    expect(await denialCount('mcp', '/mcp')).toBe(beforeMcp + 1)
  })
})
