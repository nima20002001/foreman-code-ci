import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { AutomaticReviewService } from '../src/modules/interactions/automaticReview.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { DomainError } from '../src/modules/errors.js'
import { buildProductionApp } from '../src/production.js'
import { deferred } from './helpers/deferred.js'

const config = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/test_schema_ownership' })
let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>

beforeEach(() => {
  vi.spyOn(OperatorRuntimeOwner.prototype, 'acquire').mockResolvedValue()
  vi.spyOn(OperatorRuntimeOwner.prototype, 'close').mockResolvedValue()
  vi.spyOn(OperatorChatService.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(AutomaticReviewService.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(LangGraphWorkflowEngine.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(ExecutionScopedNativeSessionManagerResolver.prototype, 'dispose').mockResolvedValue()
  database = createDatabase(config.database)
  checkpoints = createCheckpointStore(config.database.connectionString, 'schema_fixture', config.database)
  vi.spyOn(database, 'migrate').mockResolvedValue()
  vi.spyOn(checkpoints, 'setup').mockResolvedValue()
  production = buildProductionApp(config, database, checkpoints, false)
})
afterEach(async () => {
  await production.shutdown()
  await Promise.all([database.close(), checkpoints.close()])
  vi.restoreAllMocks()
})

it('acquires runtime ownership before both migration sets and keeps it until shutdown', async () => {
  const order: string[] = []
  vi.mocked(OperatorRuntimeOwner.prototype.acquire).mockImplementation(async () => { order.push('ownership') })
  vi.mocked(database.migrate).mockImplementation(async () => { order.push('application') })
  vi.mocked(checkpoints.setup).mockImplementation(async () => { order.push('checkpoints') })
  const preparing = production.prepareSchema()
  expect(production.prepareSchema()).toBe(preparing)
  await preparing
  expect(order).toEqual(['ownership', 'application', 'checkpoints'])
  expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
  await production.shutdown()
  expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledOnce()
})

it('performs no migrations when another runtime owns the database', async () => {
  vi.mocked(OperatorRuntimeOwner.prototype.acquire).mockRejectedValue(
    new DomainError('OPERATOR_API_ALREADY_OWNED', 'Another API owns this database.', 503))
  await expect(production.prepareSchema()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
  expect(database.migrate).not.toHaveBeenCalled()
  expect(checkpoints.setup).not.toHaveBeenCalled()
})

it('joins a migration during shutdown before releasing ownership or starting checkpoint DDL', async () => {
  const entered = deferred(), release = deferred()
  vi.mocked(database.migrate).mockImplementation(async () => { entered.resolve(); await release.promise })
  const preparing = production.prepareSchema().then(() => undefined, error => error)
  await entered.promise
  const closing = production.shutdown()
  try {
    expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
    expect(checkpoints.setup).not.toHaveBeenCalled()
    release.resolve()
    expect(await preparing).toMatchObject({ name: 'AbortError' })
    await closing
    expect(checkpoints.setup).not.toHaveBeenCalled()
    expect(database.migrate).toHaveBeenCalledOnce()
    expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledOnce()
  } finally { release.resolve(); await Promise.all([preparing, closing]) }
})
