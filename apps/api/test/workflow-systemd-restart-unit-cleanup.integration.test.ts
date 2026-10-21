import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './helpers/privateFixtureDirectory.js'
import { settleTestResources } from '../../../scripts/test-resources.mjs'
import { readUntil } from './helpers/observableCondition.js'
import { systemctl, restartUnit, removeRestartUnit, expectRemovedUnit } from './helpers/restartUnitFixture.js'

describe('installed Main-local workflows across systemd restart', () => {
  it.each([false, true])('removes its restart unit when the fixture body throws (failed unit: %s)', async failed => {
    const created: { service?: Awaited<ReturnType<typeof restartUnit>>; pid: number } = { pid: 0 }
    const failure = new Error('Fixture body failed')
    try {
      await expect(withPrivateFixtureDirectories(async () => {
        const directory = await privateFixtureDirectory('restart-cleanup-')
        created.service = await restartUnit(directory, failed ? 'failed' : 'active')
        await systemctl('daemon-reload')
        await systemctl('enable', created.service.unit)
        await systemctl('start', created.service.unit)
        await readUntil(async () => (await systemctl('show', created.service!.unit, '--property=ActiveState', '--value'))
          .stdout.trim(), state => state === (failed ? 'failed' : 'active'),
        { timeoutMs: 10_000, description: 'regression fixture service state' })
        created.pid = Number((await systemctl('show', created.service.unit, '--property=MainPID', '--value')).stdout.trim())
        throw failure
      })).rejects.toBe(failure)
      expect(created.service).toBeDefined()
      await expectRemovedUnit(created.service!.unit, created.service!.unitPath, created.pid)
    } finally {
      if (created.service) await removeRestartUnit(created.service.unit, created.service.unitPath)
    }
  }, 60_000)

  it('sweeps a restart unit left by an interrupted test before settling run resources', async () => {
    const directory = await privateFixtureDirectory('restart-interrupted-')
    const service = await restartUnit(directory, 'active')
    try {
      await systemctl('daemon-reload')
      await systemctl('enable', service.unit)
      await systemctl('start', service.unit)
      const pid = Number((await systemctl('show', service.unit, '--property=MainPID', '--value')).stdout.trim())
      await settleTestResources({ query: async () => { throw new Error('No fixture databases need settling') } }, {
        directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER!,
      })
      await expectRemovedUnit(service.unit, service.unitPath, pid)
    } finally {
      await removeRestartUnit(service.unit, service.unitPath)
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
