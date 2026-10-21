import pg from 'pg'
import { on } from 'node:events'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChat.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeHistory } from '../../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import { registerOperatorChatRoutes } from '../../src/routes/operatorChat.js'

export interface LocalHumanRecoveryInput { schema: string; directory: string; binary: string; databaseUrl: string }
export interface NativeRecoveryInspection { kind: 'inspect'; conversationId: string }

process.once('message', (input: LocalHumanRecoveryInput) => {
  void start(input).catch(error => {
    process.send?.({ error: error instanceof Error ? error.message : 'Recovery child failed.' })
    process.exitCode = 1
    if (process.connected) process.disconnect?.()
  })
})

async function start(input: LocalHumanRecoveryInput): Promise<void> {
  if (!/^eng04_b_[0-9a-f]+$/.test(input.schema)) throw new Error('Expected a private test schema.')
  const pool = new pg.Pool({ connectionString: input.databaseUrl,
    options: `-c search_path=${input.schema},public`, max: 4 })
  const access = new PostgresAccessService(pool)
  const observations = new Map<string, NativeHistory>()
  const registry = new NativeProcessRegistry(join(input.directory, 'processes'))
  const chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool),
    new PostgresOperatorRepository(pool), (_configuration, id) => {
      const manager = new CodexAppServerSessionManager(input.binary, undefined, undefined, registry.scope(id))
      const attach = manager.attachSession.bind(manager)
      manager.attachSession = async (...arguments_: Parameters<CodexAppServerSessionManager['attachSession']>) => {
        // Attachment must survive beyond the separate 5s observation budget during cold startup.
        await delay(5_100, undefined, { signal: arguments_[2] })
        return attach(...arguments_)
      }
      const reconcile = manager.reconcile.bind(manager)
      manager.reconcile = async (...arguments_: Parameters<CodexAppServerSessionManager['reconcile']>) => {
        const history = await reconcile(...arguments_)
        observations.set(id, history)
        return history
      }
      return manager
    }, input.directory, {
      current: id => access.currentOperator(id), assertConfiguration() {},
      setup: async () => { throw new Error('Recovery must not inspect new-work setup.') },
      prepare: async () => { throw new Error('Recovery must not issue a launch credential.') },
      release: async () => {},
    })
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as never },
    localHuman: new PostgresLocalHumanAccess(pool, access) })
  registerOperatorChatRoutes(app, chat)
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    process.send?.({ address })
    for await (const [command] of on(process, 'message')) {
      if (command === 'stop') break
      if (command === 'reconcile') {
        await chat.reconcileActive()
        process.send?.({ reconciled: true })
      }
      if (command && typeof command === 'object' && 'kind' in command && command.kind === 'inspect') {
        const inspection = command as NativeRecoveryInspection
        const history = observations.get(inspection.conversationId)
        if (!history) throw new Error('The production manager did not recover native history.')
        process.send?.({ observedHistory: history })
      }
    }
  } finally {
    await app.close()
    await chat.shutdown()
    await pool.end()
    if (process.connected) process.disconnect?.()
  }
}
