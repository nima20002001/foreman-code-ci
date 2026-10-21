import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { MainWorkerConversationMcp } from './mainWorkerMcp.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { deferred } from '../../../test/helpers/deferred.js'

it('cancels the authenticated Main call when the Operator relay request is cancelled', async () => {
  const f = workerConversationFixture()
  const binding = { ...f.binding, appMcpAccess: 'scoped' }
  const pool = { query: async () => ({ rows: [{ owner_principal_id: 'owner', delegated_from: 'owner',
    worker_conversation_binding: binding, record: f.configuration }] }) } as unknown as pg.Pool
  const profiles = { admit: vi.fn(async () => ({})) } as unknown as
    ConstructorParameters<typeof MainWorkerConversationMcp>[0]['profiles']
  const entered = deferred<AbortSignal | undefined>()
  const release = deferred<void>()
  const controller = new AbortController()
  const cause = new Error('Operator request cancelled')
  const relay = new MainWorkerConversationMcp({ pool,
    access: { authenticate: async () => ({ id: 'operator', name: 'Operator', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null }) },
    profiles, claudeProfiles: profiles, operators: new PostgresOperatorConversationRepository(pool),
    bridge: new MainWorkerConversationBridge(), current: () => f.connection,
    forward: () => ({ request: async (_body, _token, _protocol, signal) => {
      entered.resolve(signal)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal!.reason)
        signal?.addEventListener('abort', abort, { once: true })
        void release.promise.then(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        })
      })
      return { statusCode: 200, contentType: 'application/json', body: '{}' }
    } }),
  })
  const pending = relay.handle({ version: 1, operation: 'conversation-mcp.request', binding,
    token: 'operator-test-token', body: { method: 'tools/list' } }, f.connection, controller.signal)
  const outcome = pending.catch(error => error)
  try {
    expect(await entered.promise).toBe(controller.signal)
    controller.abort(cause)
    expect(await outcome).toBe(cause)
    expect(profiles.admit).toHaveBeenCalledOnce()
  } finally {
    controller.abort(cause)
    release.resolve()
    await outcome
  }
})
