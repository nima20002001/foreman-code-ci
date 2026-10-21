import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { AutomaticReviewService } from '../src/modules/interactions/automaticReview.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { buildProductionApp } from '../src/production.js'
import * as rsyncComposition from '../src/modules/byte-transfer/productionComposition.js'
import { ProductionDeviceRuntime } from '../src/modules/devices/productionRuntime.js'
import { deferred } from './helpers/deferred.js'

const config = loadConfig({ DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_shutdown_fixture' })
let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>

beforeEach(() => {
  // Mock only the public lifecycle boundaries: no private task/runtime/credential maps.
  vi.spyOn(BugReportService.prototype, 'detectStuckExecutions').mockResolvedValue(0)
  vi.spyOn(OperatorRuntimeOwner.prototype, 'acquire').mockResolvedValue()
  vi.spyOn(OperatorRuntimeOwner.prototype, 'close').mockResolvedValue()
  vi.spyOn(OperatorChatService.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(AutomaticReviewService.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(LangGraphWorkflowEngine.prototype, 'shutdown').mockResolvedValue()
  vi.spyOn(RunWorktrees.prototype, 'cleanup').mockResolvedValue()
  vi.spyOn(ExecutionScopedNativeSessionManagerResolver.prototype, 'dispose').mockResolvedValue()
  database = createDatabase(config.database)
  checkpoints = createCheckpointStore(config.database.connectionString, 'shutdown_fixture', config.database)
  production = buildProductionApp(config, database, checkpoints, false)
})
afterEach(async () => {
  // Rejections are asserted in the relevant test; these mocked fixtures hold no lock/native process.
  await production.app.close().catch(() => {
    // ignore: shutdown rejection is asserted by the test that triggers it.
  })
  await Promise.all([database.close(), checkpoints.close()])
  vi.restoreAllMocks()
})

describe('production shutdown composition', () => {
  it('keeps device channels open until their rsync writers have stopped', async () => {
    await production.app.close()
    vi.mocked(OperatorRuntimeOwner.prototype.close).mockClear()
    const entered = deferred()
    const stopped = deferred()
    const close = vi.fn(() => { entered.resolve(); return stopped.promise })
    vi.spyOn(rsyncComposition, 'createInstalledRsyncComposition').mockReturnValue({
      kind: 'configured', extensions: [], rsyncWriters: { close },
    } as unknown as ReturnType<typeof rsyncComposition.createInstalledRsyncComposition>)
    const stopDevice = vi.spyOn(ProductionDeviceRuntime.prototype, 'stop')
    production = buildProductionApp(config, database, checkpoints, false)
    const closing = production.shutdown()
    try {
      await entered.promise
      expect(stopDevice).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      stopped.resolve()
      await closing
      expect(stopDevice).toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledOnce()
    } finally {
      stopped.resolve()
      await closing
    }
  })
  it('does not release ownership when the app closes but a public runtime shutdown is pending', async () => {
    const pending = deferred(); const entered = deferred()
    vi.mocked(OperatorChatService.prototype.shutdown).mockImplementation(() => { entered.resolve(); return pending.promise })
    await production.app.ready()
    const closing = production.app.close()
    try {
      await entered.promise
      expect(AutomaticReviewService.prototype.shutdown).toHaveBeenCalledTimes(1)
      expect(LangGraphWorkflowEngine.prototype.shutdown).toHaveBeenCalledTimes(1)
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      pending.resolve()
      await closing
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).toHaveBeenCalledTimes(1)
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledTimes(1)
    } finally { pending.resolve(); await closing }
  })

  it('handles repeated shutdown during HTTP drain and hook re-entry without an early unlock or close deadlock', async () => {
    const pending = deferred(); const entered = deferred(); const preClose = deferred()
    const order: string[] = []
    production.app.get('/agent3-held-request', async () => {
      entered.resolve()
      await pending.promise
      order.push('HTTP finished')
      return { ok: true }
    })
    production.app.addHook('preClose', async () => { preClose.resolve() })
    production.app.addHook('onClose', async () => {
      await production.drainShutdown()
      order.push('infrastructure may close')
    })
    vi.mocked(OperatorRuntimeOwner.prototype.close).mockImplementation(async () => { order.push('owner released') })
    const address = await production.app.listen({ host: '127.0.0.1', port: 0 })
    const response = fetch(`${address}/agent3-held-request`).then(async (value) => {
      expect(value.status).toBe(200)
      await value.text()
    })
    await entered.promise
    const first = production.shutdown()
    try {
      await preClose.promise
      expect(production.shutdown()).toBe(first)
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      pending.resolve()
      await Promise.all([response, first])
      expect(order).toEqual(['HTTP finished', 'owner released', 'infrastructure may close'])
      expect(OperatorChatService.prototype.shutdown).toHaveBeenCalledTimes(1)
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledTimes(1)
    } finally { pending.resolve(); await Promise.allSettled([response, first]) }
  }, 10_000)

  it('drains in-flight recovery before disposing managers and does not admit another recovery page', async () => {
    const pending = deferred(); const entered = deferred()
    vi.spyOn(production.engine, 'reconcile').mockImplementation(() => { entered.resolve(); return pending.promise })
    const recover = vi.spyOn(InteractionService.prototype, 'recover')
    const running = production.reconcile(vi.fn())
    await entered.promise
    const closing = production.shutdown()
    try {
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      pending.resolve()
      await Promise.all([running, closing])
      await production.reconcile(vi.fn())
      expect(RunWorktrees.prototype.cleanup).not.toHaveBeenCalled()
      expect(recover).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledTimes(1)
    } finally { pending.resolve(); await Promise.allSettled([running, closing]) }
  })

  it('drains worktree cleanup already in progress before disposing managers', async () => {
    const pending = deferred()
    const entered = deferred()
    vi.spyOn(production.engine, 'reconcile').mockResolvedValue()
    vi.mocked(RunWorktrees.prototype.cleanup).mockImplementation(() => {
      entered.resolve()
      return pending.promise
    })
    const recover = vi.spyOn(InteractionService.prototype, 'recover')
    const running = production.reconcile(vi.fn())
    await entered.promise
    const closing = production.shutdown()
    try {
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      pending.resolve()
      await Promise.all([running, closing])
      await production.reconcile(vi.fn())
      expect(RunWorktrees.prototype.cleanup).toHaveBeenCalledOnce()
      expect(recover).not.toHaveBeenCalled()
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).toHaveBeenCalledOnce()
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledOnce()
    } finally {
      pending.resolve()
      await Promise.allSettled([running, closing])
    }
  })

  it('drains acquisition during canceled startup even though initialized never became true', async () => {
    const pending = deferred(); const entered = deferred()
    vi.mocked(OperatorRuntimeOwner.prototype.acquire).mockImplementation(() => { entered.resolve(); return pending.promise })
    const ensure = vi.spyOn(PostgresOperatorRepository.prototype, 'ensure')
    const initializing = production.initialize()
    void initializing.catch(() => {
      // ignore: the startup rejection is asserted below after shutdown drains.
    })
    await entered.promise
    const closing = production.shutdown()
    try {
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
      pending.resolve()
      await expect(initializing).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_CLOSING' })
      await closing
      expect(ensure).not.toHaveBeenCalled()
      expect(OperatorRuntimeOwner.prototype.close).toHaveBeenCalledTimes(1)
      await expect(production.initialize()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_CLOSING' })
    } finally { pending.resolve(); await Promise.allSettled([initializing, closing]) }
  })

  for (const boundary of ['chat', 'reviews', 'engine', 'managers'] as const) {
    it(`reports a public ${boundary} cleanup failure and never releases ownership`, async () => {
      const failure = new Error('unconfirmed protected cleanup')
      const method = boundary === 'chat' ? OperatorChatService.prototype.shutdown
        : boundary === 'reviews' ? AutomaticReviewService.prototype.shutdown
          : boundary === 'engine' ? LangGraphWorkflowEngine.prototype.shutdown
            : ExecutionScopedNativeSessionManagerResolver.prototype.dispose
      vi.mocked(method).mockRejectedValue(failure)
      await expect(production.shutdown()).rejects.toThrow('runtime ownership was not released')
      await expect(production.drainShutdown()).rejects.toThrow('runtime ownership was not released')
      expect(ExecutionScopedNativeSessionManagerResolver.prototype.dispose).toHaveBeenCalledTimes(boundary === 'managers' ? 2 : 1)
      expect(OperatorRuntimeOwner.prototype.close).not.toHaveBeenCalled()
    })
  }
})
