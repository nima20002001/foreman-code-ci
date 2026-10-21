import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { commit, mainId } from './helpers/ciPreparationFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { mainPreparationRecoverySuite } from './helpers/mainPreparationRecoverySuite.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('Main CI preparation interruption and recovery', () => {
  const suite = mainPreparationRecoverySuite()
  const { input, settle, readBoth } = suite

  it.each(['refresh', 'capture', 'qualify', 'source', 'root', 'profile'] as const)(
    'resumes Main after interruption at %s without repeating completed side effects', async stage => {
      const reached = rejectableDeferred()
      const paused = rejectableDeferred()
      let interrupted = false
      const waitForRelease = async () => {
        if (interrupted) return
        reached.resolve()
        await paused.promise
      }
      const f = await suite.createFixture({
        pause: async current => { if (current === stage) await waitForRelease() },
        ...(stage === 'refresh' ? { onMainRefresh: waitForRelease } : {}),
      })
      const original = await f.create()
      const request = input(f)
      try {
        expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
        expect(await f.repository.pending()).toEqual([])
        expect((await original.call('build_computer_prepare', request)).isError).not.toBe(true)
        await reached.promise
        const pending = (await f.repository.pending())[0]!
        expect(pending.status.deviceId).toBe(mainId)
        expect(await readBoth(original)).toEqual(pending.status)
        interrupted = true
        const closing = original.service.close()
        paused.resolve()
        await closing
        const saved = await f.repository.get(pending.id)
        expect(saved.status.state).not.toBe('failed')
        const recovered = await f.create()
        await Promise.all([recovered.service.recover(), recovered.service.recover()])
        const completed = await settle(recovered)
        expect(completed).toMatchObject({ state: 'qualified', deviceId: mainId, commit,
          profiles: [{ profileId: 'p-main', revision: 4, status: 'qualified' }] })
        expect(await readBoth(recovered)).toEqual(completed)
        const replay = await recovered.call('build_computer_prepare', request)
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(replay))).toEqual(completed)
        const replayHttp = await recovered.httpStart({ commandId: request.commandId, commit })
        expect(replayHttp.status).toBe(200)
        expect(BuildComputerPrepareStatusSchema.parse(await replayHttp.json())).toEqual(completed)
        expect(await f.repository.pending()).toEqual([])
        expect((await suite.database.pool.query('select id,device_id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: pending.id, device_id: mainId, active: false }])
        expect((await suite.database.pool.query(`select result from management_command_receipts
          where principal_id=$1 and operation='build_computer_prepare' and command_id=$2`,
        [f.writer.principal.id, request.commandId])).rows).toEqual([{ result: { operationId: pending.id } }])
        expect(f.fixture.calls.prepare).toHaveLength(1)
        expect(f.fixture.calls.refresh).toHaveLength(1)
        expect(f.fixture.calls.bind).toHaveLength(1)
        expect(f.fixture.calls.saves).toHaveLength(1)
        expect(f.fixture.calls.qualified).toEqual(['p-main'])
      } finally {
        interrupted = true
        paused.resolve()
      }
    }, 30_000)
})
