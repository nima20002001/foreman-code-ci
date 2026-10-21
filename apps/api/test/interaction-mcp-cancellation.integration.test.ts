import { workerToolServices } from './helpers/workerMcpServices.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (closes.length) await closes.pop()!()
  vi.restoreAllMocks()
})

async function setup() {
  const f = await approvalDatabase()
  closes.push(f.close)
  const app = buildApp({
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: workerToolServices(f.pool, f.commands).appMcp(f.access, new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)),
  })
  const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
  closes.push(() => app.close())
  const token = f.credential.environment.variables.GRAPHQL_MCP_TOKEN!
  async function post(body: unknown, bearer = token) {
    return fetch(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26',
    }, body: JSON.stringify(body) })
  }
  const cancel = (requestId: number, bearer = token) => post({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
  }, bearer)
  const call = (id: number, name: string, args: unknown) => post({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  })
  const args = { interactionId: f.interaction.id, expectedRevision: f.interaction.revision,
    optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId }
  return { ...f, post, cancel, call, args }
}

async function result(response: Response) {
  expect(response.status).toBe(200)
  const text = await response.text()
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : text
  return JSON.parse(data) as { id: number; result: { isError?: boolean; content: unknown; structuredContent?: unknown } }
}

describe.skipIf(!postgresEnabled)('authenticated interaction MCP cancellation', () => {
  it('cancels a waiting decision before commit, without affecting another request or accepting another caller', async () => {
    const f = await setup()
    const outsider = await f.credentials.issueForReviewer(f.reviewer.id)
    const outsiderToken = outsider.environment.variables.GRAPHQL_MCP_TOKEN!
    const locked = rejectableDeferred<void>()
    const release = rejectableDeferred<void>()
    const locking = withTransaction(f.pool, async lock => {
      await lock.query('select id from management_principals where id=$1 for update', [f.principal.id])
      locked.resolve()
      await release.promise
    })
    const entered = rejectableDeferred<AbortSignal>()
    const decide = f.repository.decide.bind(f.repository)
    vi.spyOn(f.repository, 'decide').mockImplementation(async (input) => {
      entered.resolve(input.signal!)
      return decide(input)
    })
    try {
      await Promise.race([locked.promise, locking])
      const pending = f.call(71, 'interaction_respond', f.args)
      const signal = await entered.promise
      expect((await f.cancel(71, outsiderToken)).status).toBe(202)
      expect(signal.aborted).toBe(false)
      const concurrent = await result(await f.call(72, 'interaction_get', { interactionId: f.interaction.id }))
      expect(concurrent.result.isError).not.toBe(true)
      expect((await f.cancel(71)).status).toBe(202)
      expect(signal.aborted).toBe(true)
      release.resolve()
      await locking
      const cancelled = await result(await pending)
      expect(cancelled.id).toBe(71)
      expect(cancelled.result.isError).toBe(true)
      expect(JSON.stringify(cancelled.result.content)).toContain('MCP_REQUEST_CANCELLED')
      expect(await f.repository.get(f.interaction.id)).toMatchObject({
        revision: f.interaction.revision, status: 'pending', deliveryState: 'not_started',
      })
      expect(f.counts().responses).toBe(0)
    } finally {
      release.resolve()
      await locking
    }
  }, 60_000)

  it('preserves a committed decision and returns its recorded outcome after cancellation', async () => {
    const f = await setup()
    const committed = rejectableDeferred<AbortSignal>()
    const release = rejectableDeferred<void>()
    closes.push(async () => release.resolve())
    const decide = f.repository.decide.bind(f.repository)
    vi.spyOn(f.repository, 'decide').mockImplementation(async (input) => {
      const decision = await decide(input)
      committed.resolve(input.signal!)
      await release.promise
      return decision
    })
    const pending = f.call(81, 'interaction_respond', f.args)
    const signal = await committed.promise
    expect(await f.repository.get(f.interaction.id)).toMatchObject({ selectedOptionId: f.args.optionId })
    expect((await f.cancel(81)).status).toBe(202)
    expect(signal.aborted).toBe(true)
    release.resolve()
    const completed = await result(await pending)
    expect(completed.id).toBe(81)
    expect(completed.result.isError).not.toBe(true)
    const persisted = await f.repository.get(f.interaction.id)
    expect(persisted).toMatchObject({ revision: f.interaction.revision + 1,
      selectedOptionId: f.args.optionId, selectedSemantic: 'approve_once' })
    expect(persisted?.status).not.toBe('canceled')
    const readback = await result(await f.call(82, 'interaction_get', { interactionId: f.interaction.id }))
    expect(readback.result.structuredContent).toMatchObject({ interaction: { selectedOptionId: f.args.optionId } })
  }, 60_000)
})
