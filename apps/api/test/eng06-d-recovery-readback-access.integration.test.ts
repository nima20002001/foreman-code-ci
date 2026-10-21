import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, readParity, recoveryFixture, runPath, scope, type RecoveryFixture, type Transport } from './helpers/eng06DRecovery.js'
import { forms } from './helpers/recoveryReadback.js'

function errorCode(result: unknown) {
  const message = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  expect(message.isError).toBe(true)
  const text = message.content?.find((item) => item.type === 'text')?.text
  expect(text).toBeDefined()
  return (JSON.parse(text!) as { error: { code: string } }).error.code
}
async function denyRead(f: RecoveryFixture, client: Transport['client'], token: string,
  name: 'run_record_get' | 'run_execution_get', executionId?: string) {
  const input = { ...scope(f), ...(executionId ? { executionId } : {}) }
  const response = await f.transport.app.inject({ method: 'GET',
    url: `${runPath(f)}${executionId ? `/executions/${executionId}` : '/record'}`,
    headers: { authorization: `Bearer ${token}` } })
  expect(response.statusCode, response.body).toBe(403)
  expect(response.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect(errorCode(await client.callTool({ name, arguments: input }))).toBe('ACCESS_DENIED')
}

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: rebuilt HTTP/MCP reads retain live grants, redaction, denied-scope audits and read-only behavior', async (form) => {
    const f = await recoveryFixture(form)
    try {
      f.launch()
      await f.settled(f.base.f.run.id, { pollIntervalMs: 25 })
      await f.restart()
      const expected = await readback(f), executionId = expected.details[0]!.execution.executionId
      const allowed = await f.base.access.issue({ name: 'ENG06 restarted runs-only reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { runIds: [f.base.f.run.id] } }] })
      const client = await f.transport.connect(allowed.token), counts = { ...f.provider.counts }
      const record = RunRecordDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.record, scope(f), client, allowed.token))
      const redacted = structuredClone(expected.record); delete redacted.run.executionLocation
      expect(record).toEqual(redacted); expect(record.run).not.toHaveProperty('authorizationPrincipalId')
      const detail = await readParity(f, RUN_INSPECTION_TOOLS.execution, { ...scope(f), executionId }, client, allowed.token)
      expect(detail).toEqual(expected.details[0])
      const tools = (await client.listTools()).tools
      expect(tools.find((tool) => tool.name === RUN_INSPECTION_TOOLS.record)?.annotations?.readOnlyHint).toBe(true)
      expect(tools.map((tool) => tool.name)).not.toContain('run_start')
      expect(tools.map((tool) => tool.name)).not.toContain('run_stop')
      const wrongScope = await f.base.access.issue({ name: 'ENG06 wrong Run reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }] })
      const denied = await f.transport.connect(wrongScope.token)
      await denyRead(f, denied, wrongScope.token, RUN_INSPECTION_TOOLS.record)
      await denyRead(f, denied, wrongScope.token, RUN_INSPECTION_TOOLS.execution, executionId)
      const audits = (await f.base.db.pool.query<{ source: string }>('select source from management_audit where principal_id=$1',
        [wrongScope.principal.id])).rows
      expect(audits.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      expect((await f.transport.app.inject({ method: 'GET', url: `${runPath(f)}/record`, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      expect((await f.transport.app.inject({ method: 'GET', url: `${runPath(f)}/executions/${executionId}`, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      expect(f.provider.counts).toEqual(counts)
      expect(await readback(f)).toEqual(expected)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
