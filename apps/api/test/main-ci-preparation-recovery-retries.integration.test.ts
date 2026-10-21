import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { commit, mainId } from './helpers/ciPreparationFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { mainPreparationRecoverySuite } from './helpers/mainPreparationRecoverySuite.js'
import { DeviceConnectionError } from '../src/modules/devices/deviceWire.js'

describe.skipIf(!postgresEnabled)('Main CI preparation interruption and recovery', () => {
  const suite = mainPreparationRecoverySuite()
  const { input, settle, readBoth } = suite

  it('keeps repeated refreshes separate while HTTP and MCP retries reuse each completed operation', async () => {
    const f = await suite.createFixture()
    const runtime = await f.create()
    const first = input(f)
    const denied = await runtime.httpStart({ commandId: first.commandId, commit }, f.reader.token)
    expect(denied.status).toBe(403)
    expect((await runtime.call('build_computer_prepare', first, f.reader.token)).isError).toBe(true)
    expect((await suite.database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
    const started = await runtime.httpStart({ commandId: first.commandId, commit })
    expect(started.status).toBe(200)
    const initial = await settle(runtime)
    expect(initial.state).toBe('qualified')
    const original = (await f.repository.latestForDevice(mainId))!
    const same = await runtime.call('build_computer_prepare', first)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(same))).toEqual(initial)
    expect(f.fixture.calls.refresh).toHaveLength(1)
    const second = input(f)
    expect((await runtime.call('build_computer_prepare', second)).isError).not.toBe(true)
    const completed = await settle(runtime)
    expect(completed).toMatchObject({ state: 'qualified', profiles: [
      { profileId: 'p-main', revision: 5, status: 'qualified' },
    ] })
    expect(await readBoth(runtime)).toEqual(completed)
    const latest = (await f.repository.latestForDevice(mainId))!
    expect(latest.id).not.toBe(original.id)
    expect(await f.repository.get(original.id)).toEqual(original)
    expect(f.fixture.calls.refresh).toEqual([
      expect.objectContaining({ operationId: original.id }), expect.objectContaining({ operationId: latest.id }),
    ])
    expect((await suite.database.pool.query('select id,active from ci_runtime_preparations order by created_at')).rows)
      .toEqual([{ id: original.id, active: false }, { id: latest.id, active: false }])
    expect((await suite.database.pool.query(`select source,outcome from management_audit
      where principal_id=$1 and action='build_computer_prepare' order by sequence`, [f.reader.principal.id])).rows)
      .toEqual([{ source: 'http', outcome: 'denied' }, { source: 'mcp', outcome: 'denied' }])
    await Promise.all([runtime.service.recover(), runtime.service.recover()])
    await vi.waitFor(() => { expect(f.fixture.calls.refresh).toHaveLength(2) })
  }, 30_000)

  it('reconciles an accepted Main refresh after its acknowledgement is lost', async () => {
    const f = await suite.createFixture({
      onMainRefresh: async () => { throw new DeviceConnectionError('transport') },
    })
    const runtime = await f.create()
    const request = input(f)
    expect((await runtime.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
    expect((await runtime.call('build_computer_prepare', request)).isError).not.toBe(true)
    const completed = await settle(runtime)
    expect(completed.state).toBe('qualified')
    expect(await readBoth(runtime)).toEqual(completed)
    expect(f.fixture.calls.refresh).toHaveLength(1)
    expect(f.fixture.calls.qualified).toEqual(['p-main'])
    expect(await f.repository.pending()).toEqual([])
  }, 30_000)
})
