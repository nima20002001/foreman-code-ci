import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { mainPreparationRecoverySuite } from './helpers/mainPreparationRecoverySuite.js'
import { randomUUID } from 'node:crypto'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('Main CI preparation interruption and recovery', () => {
  const suite = mainPreparationRecoverySuite()
  const { input, settle, readBoth } = suite

  it.each(['builds disabled', 'Main changed', 'writer revoked'] as const)(
    'retains a failed pending preparation when recovery finds %s', async condition => {
      const reached = rejectableDeferred()
      const paused = rejectableDeferred()
      let interrupted = false
      const f = await suite.createFixture({ pause: async stage => {
        if (stage === 'source' && !interrupted) {
          reached.resolve()
          await paused.promise
        }
      } })
      const original = await f.create()
      const request = input(f)
      try {
        expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
        expect((await original.call('build_computer_prepare', request)).isError).not.toBe(true)
        await reached.promise
        const pending = (await f.repository.pending())[0]!
        interrupted = true
        const closing = original.service.close()
        paused.resolve()
        await closing
        if (condition === 'builds disabled') {
          await suite.database.pool.query('update build_computer_preferences set build_enabled=false')
        } else if (condition === 'Main changed') {
          await suite.database.pool.query('update application_installation set id=$1 where singleton=true', [randomUUID()])
        } else {
          await suite.database.pool.query('update management_principals set revoked_at=now() where id=$1',
            [f.writer.principal.id])
        }
        const recovered = await f.create()
        await recovered.service.recover()
        const completed = await settle(recovered)
        expect(completed.state).toBe('failed')
        expect(completed.message).toBeTruthy()
        expect(await readBoth(recovered)).toEqual(completed)
        expect(await f.repository.get(pending.id)).toMatchObject({ id: pending.id, status: completed })
        expect(await f.repository.pending()).toEqual([])
        expect(f.fixture.calls.prepare).toEqual([])
        expect(f.fixture.calls.refresh).toEqual([])
        expect(f.fixture.calls.qualified).toEqual([])
        expect((await suite.database.pool.query('select id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: pending.id, active: false }])
      } finally {
        interrupted = true
        paused.resolve()
      }
    }, 30_000)
})
