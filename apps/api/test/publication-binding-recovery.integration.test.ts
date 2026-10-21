import { afterEach, describe, expect, it, vi } from 'vitest'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { preparePublication } from './helpers/codexPublication.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('publication binding recovery', { timeout: 90_000 }, () => {
  for (const selectedRun of [false, true]) {
    it(`cold ${selectedRun ? 'selected-Run' : 'Agent'} readback excludes every foreign immutable publication binding`, async () => {
      const f = await afPublicationFixture({ selectedRun })
      const foreignContexts: Array<(bound: FileToolContext) => FileToolContext> = [
        bound => ({ ...bound, ownerPrincipalId: 'foreign-owner' }),
        bound => ({ ...bound, nativeSessionId: 'foreign-thread' }),
        bound => ({ ...bound, turnId: 'foreign-turn' }),
        bound => ({ ...bound, messageId: 'foreign-message' }),
        bound => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, conversationId: 'foreign-conversation' } } }),
        bound => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run', executionId: 'foreign-execution' } } }),
        ...(selectedRun ? [
          (bound: FileToolContext) => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run' } } }),
          (bound: FileToolContext) => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, executionId: 'foreign-execution' } } }),
        ] : []),
      ]
      for (const foreign of foreignContexts) {
        const t = await preparePublication(f, 0, 'lose_close')
        const append = PostgresFileToolRepository.prototype.linkPublication
        // Inject stale/foreign receipt identity BEFORE the real append-only insert;
        // authentication, allocation, finalization and readback remain production.
        const insertion = vi.spyOn(PostgresFileToolRepository.prototype, 'linkPublication')
          .mockImplementationOnce(function (this: PostgresFileToolRepository, link) {
            return append.call(this, { ...link, binding: bindingIdentity(foreign(link.context)) })
          })
        try { expect((await t.publish()).success).toBe(false) } finally { insertion.mockRestore() }
        const receipts = await f.publications(t.active.turn.messageId)
        expect(receipts).toHaveLength(1)
        f.native.onFinish = undefined
        f.native.finish(); await f.settle()
        const starts = f.native.starts
        expect(await f.readPins(t.active.turn.messageId)).toEqual([])
        expect(await f.readPins(t.active.turn.messageId)).toEqual([])
        expect(await f.publications(t.active.turn.messageId)).toEqual(receipts)
        expect(f.native.starts).toBe(starts)
        await t.bridge.close()
      }
    })
  }
})
