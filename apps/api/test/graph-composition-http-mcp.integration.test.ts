import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS, RepeatGraphPageV3Schema, RepeatGraphSnapshotV3Schema,
  reduceRepeatGraphPageV3, type CurrentFixtureForm,
} from '@foreman-code/contracts/wave25'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import {
  graphFixture, graphUrl, graphHeaders, graphRpc, graphRpcValue, changeRunState, privateCanary,
  type GraphFixture, type GraphTestDatabase,
} from './eng04-graph-composition-fixture.js'

/** Real bearer authentication and actual stateless Operator MCP HTTP transport,
 * using the same PostgreSQL/publisher/read service. No mock principal, browser
 * identity, native harness, engine adapter or bypass of the disposable DB gate.
 */
describe.skipIf(!postgresEnabled)('graph composition / authenticated HTTP and Operator MCP', () => {
  let db: GraphTestDatabase
  const fixtures: GraphFixture[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(qualifiedReads = true, form: CurrentFixtureForm = 'repeat') {
    const t = await graphFixture(db, { qualifiedReads, form }); fixtures.push(t); return t
  }
  const http = (t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string, token = t.writer.token) =>
    t.app.inject({ method: 'GET', url: graphUrl(t, kind, after), headers: graphHeaders(token) })
  const mcp = (t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string, token = t.writer.token) =>
    graphRpc(t.app, token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], arguments: {
      ...t.readRequest, ...(after === undefined ? {} : { afterSequence: after }),
    } })

  it('lists canonical current and returns equal current/snapshot/complete-delta cuts on both authenticated transports', async () => {
    const t = await fixture()
    const list = await graphRpc(t.app, t.writer.token, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.result?.tools?.map((tool) => tool.name)).toContain(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)
    const baseline = await http(t, 'snapshot')
    expect(baseline.statusCode, baseline.body).toBe(200)
    const initial = RepeatGraphSnapshotV3Schema.parse(baseline.json())
    let previous = initial
    for (const state of ['running', 'waiting'] as const) {
      await changeRunState(db, t, state)
      const snapshot = RepeatGraphSnapshotV3Schema.parse((await http(t, 'snapshot')).json())
      expect(snapshot.state.run.executionState).toBe(state)
      expect((await http(t, 'current')).json().state.run.executionState).toBe(state)
      expect(graphRpcValue((await mcp(t, 'current')).result)).toMatchObject({
        state: { run: { executionState: state } }, asOfSequence: snapshot.asOfSequence,
      })
      const delta = RepeatGraphPageV3Schema.parse((await http(t, 'events', previous.asOfSequence)).json())
      expect(delta.baseSequence).toBe(previous.asOfSequence)
      expect(BigInt(delta.throughSequence)).toBe(BigInt(previous.asOfSequence) + 1n)
      expect(delta.headSequence).toBe(snapshot.asOfSequence)
      expect(delta.throughSequence).toBe(snapshot.asOfSequence)
      expect(delta.batches).toHaveLength(1)
      expect(delta.batches[0]).toMatchObject({
        previousSequence: previous.asOfSequence, sequence: snapshot.asOfSequence,
        events: expect.arrayContaining([expect.objectContaining({
          fact: { type: 'repeat.run.state', state: expect.objectContaining({ executionState: state }) },
        })]),
      })
      expect(graphRpcValue((await mcp(t, 'events', previous.asOfSequence)).result)).toEqual(delta)
      expect(reduceRepeatGraphPageV3(previous, delta)).toEqual(snapshot)
      previous = snapshot
    }
    for (const kind of ['current', 'snapshot', 'events'] as const) {
      const cursor = kind === 'events' ? initial.asOfSequence : undefined
      const read = await http(t, kind, cursor), remote = await mcp(t, kind, cursor)
      expect(read.statusCode, read.body).toBe(200)
      expect(remote.status).toBe(200)
      expect(remote.result?.isError).not.toBe(true)
      expect(graphRpcValue(remote.result)).toEqual(read.json())
      expect(read.headers['cache-control']).toBe('private, no-store')
      expect(read.headers.vary).toBe('Authorization')
      expect(read.body).not.toContain(privateCanary)
      expect(read.body).not.toContain(db.directory)
      expect(read.body).not.toContain(t.writer.principal.id)
    }
    const page = RepeatGraphPageV3Schema.parse((await http(t, 'events', initial.asOfSequence)).json())
    expect(reduceRepeatGraphPageV3(initial, page)).toEqual((await http(t, 'snapshot')).json())
    expect(page.hasMore).toBe(false)
  })

  it('registers real v3 reads but leaves them unavailable by default and does not advertise v3 qualification', async () => {
    const t = await fixture(false)
    for (const kind of ['current', 'snapshot', 'events'] as const) {
      const after = kind === 'events' ? '0' : undefined
      const read = await http(t, kind, after), remote = await mcp(t, kind, after)
      expect(read.statusCode).not.toBe(200)
      expect(read.json()).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
      expect(remote.result?.isError).toBe(true)
      expect(graphRpcValue(remote.result)).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
    }
    const capabilities = await t.app.inject({ method: 'GET', url: '/api/capabilities/run-graph/v1', headers: graphHeaders(t.writer.token) })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json().readSemanticsVersions).toEqual([])
    expect(capabilities.json().semantics3.persistedReads).toBe(false)
  })

  it('denies invalid, revoked, wrong-scope and missing-runs:read credentials and audits both transport denials', async () => {
    const t = await fixture()
    const missing = await t.app.inject({ method: 'GET', url: graphUrl(t, 'snapshot'), headers: graphHeaders('invalid') })
    expect(missing.statusCode).toBe(401)
    const wrong = await t.credential([{ actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])
    const noRead = await t.credential([{ actions: ['capabilities:read'], scope: {} }])
    for (const credential of [wrong, noRead]) {
      const deniedHttp = await http(t, 'snapshot', undefined, credential.token)
      const deniedMcp = await mcp(t, 'snapshot', undefined, credential.token)
      expect(deniedHttp.statusCode).toBe(403)
      expect(deniedHttp.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(deniedMcp.result?.isError).toBe(true)
      expect(graphRpcValue(deniedMcp.result)).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
      const audit = (await db.pool.query('select source,outcome from management_audit where principal_id=$1', [credential.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'http', outcome: 'denied' }), expect.objectContaining({ source: 'mcp', outcome: 'denied' }),
      ]))
    }
    await t.access.revoke(t.writer.principal.id)
    expect((await http(t, 'snapshot')).statusCode).toBe(401)
    expect((await mcp(t, 'snapshot')).status).toBe(401)
  })

  it('rejects unknown semantics, extra fields, malformed cursors and mismatched exact scope without coercion', async () => {
    const t = await fixture()
    for (const text of ['01', '-1', '1e0', '9223372036854775808']) {
      const bad = await http(t, 'events', text)
      expect(bad.statusCode).not.toBe(200)
      expect(bad.json()).toMatchObject({ error: { code: 'GRAPH_INVALID_CURSOR' } })
      const remote = await mcp(t, 'events', text)
      expect(remote.error !== undefined || remote.result?.isError === true).toBe(true)
    }
    for (const query of ['executionSemanticsVersion=1', 'executionSemanticsVersion=2', 'executionSemanticsVersion=4', 'executionSemanticsVersion=03', 'executionSemanticsVersion=3&extra=1']) {
      const url = graphUrl(t, 'snapshot').replace('executionSemanticsVersion=3', query)
      expect((await t.app.inject({ method: 'GET', url, headers: graphHeaders(t.writer.token) })).statusCode).not.toBe(200)
    }
    for (const scope of [{ ...t.scope, executionSemanticsVersion: 4 }, { ...t.scope, executionSemanticsVersion: '3' },
      { ...t.scope, workflowVersionId: 'different-pin' }, { ...t.scope, workspaceId: 'wrong-workspace' }]) {
      const result = await graphRpc(t.app, t.writer.token, 'tools/call', {
        name: CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, arguments: { protocolVersion: 1, scope },
      })
      expect(result.error !== undefined || result.result?.isError === true).toBe(true)
    }
  })

  it.each(['single', 'sequential', 'parallel', 'conditional', 'approval'] as const)(
    '%s uses ordinary current V3 with omitted repeat on both transports', async (form) => {
      const t = await fixture(true, form)
      expect(Object.hasOwn(t.version.definition, 'repeat')).toBe(false)
      for (const kind of ['snapshot', 'current', 'events'] as const) {
        const after = kind === 'events' ? '0' : undefined
        const read = await http(t, kind, after), remote = await mcp(t, kind, after)
        expect(read.statusCode, read.body).toBe(200)
        expect(remote.result?.isError).not.toBe(true)
        expect(graphRpcValue(remote.result)).toEqual(read.json())
        if (kind !== 'events') expect(Object.hasOwn(read.json().topology, 'repeat')).toBe(false)
      }
      expect(Object.hasOwn(t.run, 'repeat')).toBe(false)
    })
})
