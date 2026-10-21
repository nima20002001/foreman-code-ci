import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { mainPreparationRecoverySuite } from './helpers/mainPreparationRecoverySuite.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('Main CI preparation interruption and recovery', () => {
  const suite = mainPreparationRecoverySuite()
  const { input, settle, readBoth } = suite

  it('fences a disconnected owner before a replacement commits the same pending preparation', async () => {
    const reached = rejectableDeferred()
    const paused = rejectableDeferred()
    const disconnected = rejectableDeferred()
    const acquired = rejectableDeferred<JobOwnership>()
    let interrupted = false
    const installationId = randomUUID()
    const f = await suite.createFixture({
      mainInstallationId: installationId,
      acquire: async (pool, id, onLost) => {
        const owner = await JobOwnership.acquire(pool, id, () => {
          onLost()
          disconnected.resolve()
        })
        if (owner) acquired.resolve(owner)
        return owner
      },
      pause: async stage => {
        if (stage === 'profile' && !interrupted) {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const original = await f.create()
    const replacement = await f.create()
    const request = input(f)
    try {
      expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
      const started = await original.call('build_computer_prepare', request)
      expect(started.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(started)))
        .toMatchObject({ state: 'approving', deviceId: installationId })
      await reached.promise
      const pending = (await f.repository.pending())[0]!
      const owner = await acquired.promise
      const competing = await JobOwnership.acquire(suite.database.pool, `ci-runtime:${installationId}`, () => undefined)
      try { expect(competing).toBeUndefined() } finally { await competing?.release() }
      const pid = await owner.connection.transaction(async sql => {
        const fence = await owner.readFence(sql)
        return Number(fence.ownerId)
      })
      expect((await suite.database.pool.query<{ stopped: boolean }>(
        'select pg_terminate_backend($1) as stopped', [pid])).rows[0]!.stopped).toBe(true)
      await disconnected.promise
      interrupted = true
      await replacement.service.recover()
      const completed = await settle(replacement)
      expect(completed.state).toBe('qualified')
      const saved = await f.repository.get(pending.id)
      paused.resolve()
      await original.service.close()
      expect(await f.repository.get(pending.id)).toEqual(saved)
      expect(await readBoth(replacement)).toEqual(completed)
      expect(f.fixture.calls.prepare).toHaveLength(1)
      expect(f.fixture.calls.bind).toHaveLength(1)
      expect(f.fixture.calls.saves).toHaveLength(1)
      expect(f.fixture.calls.refresh).toHaveLength(1)
      expect(f.fixture.calls.qualified).toEqual(['p-main'])
    } finally {
      interrupted = true
      paused.resolve()
    }
  }, 30_000)

  it('expires a persisted refresh deadline instead of trusting a stale operation indefinitely', async () => {
    const reached = rejectableDeferred()
    const paused = rejectableDeferred()
    let interrupted = false
    const installationId = randomUUID()
    const f = await suite.createFixture({
      mainInstallationId: installationId,
      onMainRefresh: async () => {
        if (!interrupted) {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const original = await f.create()
    const request = input(f)
    try {
      const started = await original.call('build_computer_prepare', request)
      expect(started.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(started)))
        .toMatchObject({ state: 'approving', deviceId: installationId })
      await reached.promise
      const pending = (await f.repository.pending())[0]!
      expect(pending.status.state).toBe('refreshing')
      interrupted = true
      const closing = original.service.close()
      paused.resolve()
      await closing
      f.advance(15 * 60_000 + 1)
      const recovered = await f.create()
      await recovered.service.recover()
      const completed = await settle(recovered)
      expect(completed).toMatchObject({ state: 'failed', message: 'The computer did not come back after its runtime refresh.' })
      expect(await readBoth(recovered)).toEqual(completed)
      expect(await f.repository.pending()).toEqual([])
      expect(f.fixture.calls.refresh).toHaveLength(1)
      expect(f.fixture.calls.qualified).toEqual([])
      expect((await recovered.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(
        decodeMcpToolResult((await recovered.call('build_computer_prepare', request))))).toEqual(completed)
      expect(await f.repository.get(pending.id)).toMatchObject({ status: completed })
    } finally {
      interrupted = true
      paused.resolve()
    }
  }, 30_000)
})
