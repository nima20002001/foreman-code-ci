import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { access, database, native, production, registerProductionLifecycleFixture, runtime, start } from './helpers/productionLifecycleFixture.js'
import { requestDatabaseCommand } from './helpers/requestDatabaseCommand.js'

registerProductionLifecycleFixture()

it('makes production Stop and native delivery progress with a one-slot pool', async () => {
  const { run, issuer, pending } = await start('user')

  const runUrl = `/api/management/workspaces/workspace-1/runs/${run.id}`
  const waiting = await production.app.inject({ method: 'GET', url: runUrl })
  expect(waiting.statusCode, waiting.body).toBe(200)
  expect(waiting.json().run.executionState).toBe('waiting')

  const respond = vi.mocked(CodexAppServerSessionManager.prototype.respond)
  const original = respond.getMockImplementation()!
  let entered!: () => void, release!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const permit = new Promise<void>((resolve) => { release = resolve })
  respond.mockImplementationOnce(async function (this: CodexAppServerSessionManager, ...args) {
    entered()
    await permit
    return original.apply(this, args)
  })
  const delivery = production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: {}, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  // inject starts when awaited/then'ed; keep both requests live.
  const delivered = Promise.resolve(delivery)
  await writing
  const commandId = randomUUID()
  const stopped = requestDatabaseCommand(async () => production.app.inject({ method: 'POST', url: `/api/management/workspaces/workspace-1/runs/${run.id}/stop`,
    headers: { authorization: `Bearer ${issuer.token}` }, payload: { commandId } }))
  release()
  const [response, stop] = await Promise.all([delivered, stopped])
  // Stop may cancel the graph acknowledgement after the native receipt commits.
  expect([200, 409]).toContain(response.statusCode)
  if (response.statusCode === 409) expect(response.json().error.code).toBe('GRAPH_RESUME_OWNER_LOST')
  const persisted = await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}` })
  expect(persisted.statusCode, persisted.body).toBe(200)
  expect(persisted.json().interaction.deliveryState).toBe('delivered')
  expect(stop.statusCode, stop.body).toBe(200)
  expect(native.responses).toBe(1)
  const completed = await production.app.inject({ method: 'GET', url: runUrl })
  expect(completed.statusCode, completed.body).toBe(200)
  expect(completed.json().run.executionState).toBe('completed')
})

it('retries the same Stop after a held one-slot connection returns DATABASE_BUSY', async () => {
  const { run, issuer } = await start('user')
  const commandId = randomUUID()
  const options = { method: 'POST' as const,
    url: `/api/management/workspaces/workspace-1/runs/${run.id}/stop`,
    headers: { authorization: `Bearer ${issuer.token}` }, payload: { commandId } }
  const held = await database.pool.connect()
  let released = false
  const replies: number[] = []
  try {
    const stopped = await requestDatabaseCommand(async () => {
      const response = await production.app.inject(options)
      replies.push(response.statusCode)
      if (!released) {
        expect(response.statusCode, response.body).toBe(503)
        expect(response.json().error).toMatchObject({
          code: 'DATABASE_BUSY', details: { retryable: true, newCommandRequired: false },
        })
        held.release()
        released = true
      }
      return response
    })
    expect(stopped.statusCode, stopped.body).toBe(200)
    expect(replies[0]).toBe(503)
    const replayed = await requestDatabaseCommand(async () => production.app.inject(options))
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.json()).toMatchObject({ runId: run.id, replayed: true })
    const persisted = await production.app.inject({ method: 'GET',
      url: `/api/management/workspaces/workspace-1/runs/${run.id}` })
    expect(persisted.statusCode, persisted.body).toBe(200)
    expect(persisted.json().run.executionState).toBe('completed')
  } finally {
    if (!released) held.release()
  }
})

it('revalidates the accepting authority again between attachment and the native response', async () => {
  const { issuer, pending } = await start('user')

  const before = await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}` })
  expect(before.statusCode, before.body).toBe(200)
  expect(before.json().interaction.status).toBe('pending')
  expect(before.json().interaction.deliveryState).toBe('not_started')

  const coordinator = runtime()
  const attach = coordinator.attachInteraction.bind(coordinator)
  vi.spyOn(coordinator, 'attachInteraction').mockImplementationOnce(async (...args) => {
    const attached = await attach(...args)
    await access.revoke(issuer.principal.id)
    return attached
  })
  const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: {}, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('failed')
  const persisted = await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}` })
  expect(persisted.statusCode, persisted.body).toBe(200)
  expect(persisted.json().interaction.deliveryState).toBe('failed')
  expect(native.responses).toBe(0)
})
