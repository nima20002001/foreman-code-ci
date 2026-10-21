import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, response, checkpointCut, crashAfterCommitSaver } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('BR1-003 production-composed approval/checkpoint recovery: committed-authority', () => {
  const fixture = productionFixtures()

  it.each(['stop', 'revoked_authority', 'closed_execution'] as const)(
    'a committed receipt is not continuation authority after %s', async (race) => {
      const f = await fixture()
      await f.engine.start(f.f.run.id)
      const cut = await checkpointCut(f), saver = crashAfterCommitSaver(f)
      const [interaction] = await f.pending()
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
      expect(saver.crashed).toBe(true)
      const receipts = await f.receipts(), committed = (await f.saver.getTuple(cut.config))?.pendingWrites
      expect(receipts).toHaveLength(1)
      if (race === 'stop') await f.stop()
      if (race === 'revoked_authority') await f.db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.authorizationPrincipalId])
      if (race === 'closed_execution') await f.db.pool.query('update harness_executions set worker_credentials_closed_at=clock_timestamp() where id=$1', [interaction!.executionId])
      saver.restore()
      const observe = vi.spyOn(f.native, 'observeExact')
      if (race === 'stop') await f.engine.resumeInteraction(result.interaction)
      else await expect(f.engine.resumeInteraction(result.interaction)).rejects.toMatchObject({
        code: race === 'revoked_authority' ? 'RUN_AUTHORIZATION_REVOKED' : 'EXECUTION_STOPPED',
      })
      expect(observe).not.toHaveBeenCalled()
      expect(await f.receipts()).toEqual(receipts)
      expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(committed)
      expect(f.provider.counts.responses).toBe(1)
    }, 60000)
})
