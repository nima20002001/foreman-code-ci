import { expect, it } from 'vitest'
import { fakeComputer, fakeFleet, mcpRequest, settle } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

it.each(['http://localhost:7000/mcp', 'http://127.0.0.1:7000/mcp', 'http://[::1]:7000/mcp'])(
  'retires fleet-owned copies excluded by a host-local URL %s and preserves independent entries', async url => {
    const computer = fakeComputer()
    await computer.maintenance.start(mcpRequest(['docs']))
    await settle(computer)
    computer.codexMcp.add('local')
    computer.claudeMcp.set('local', { type: 'http', url })
    computer.maintenance = new ComputerMaintenance(computer.ports)
    const f = fakeFleet(computer)
    f.sources.codexUserMcpServers = async () => ({ docs: { url }, local: { url } })
    f.sources.claudeUserMcpServers = f.sources.codexUserMcpServers
    await f.fleet.syncChangedSources()
    await settle(computer)
    expect(computer.codexMcp.has('docs')).toBe(false)
    expect(computer.claudeMcp.has('docs')).toBe(false)
    expect(computer.codexMcp.has('local')).toBe(true)
    expect(computer.claudeMcp.has('local')).toBe(true)
    const removals = computer.calls.filter(call => call.args[1] === 'remove')
    expect(removals).toHaveLength(2)
    // Persisted ownership no longer requests a removal on another sync.
    computer.maintenance = new ComputerMaintenance(computer.ports)
    const restarted = fakeFleet(computer)
    restarted.sources.codexUserMcpServers = f.sources.codexUserMcpServers
    restarted.sources.claudeUserMcpServers = f.sources.claudeUserMcpServers
    await restarted.fleet.syncChangedSources()
    await settle(computer)
    expect(computer.calls.filter(call => call.args[1] === 'remove')).toEqual(removals)
    await Promise.all([f.fleet.drain(), restarted.fleet.drain()])
  },
)

it('preserves managed copies while a definition or entire catalog is temporarily unavailable', async () => {
  const computer = fakeComputer()
  await computer.maintenance.start(mcpRequest(['docs']))
  await settle(computer)
  const f = fakeFleet(computer)
  f.sources.codexUserMcpServers = async () => ({ docs: { url: 'https://docs.example/mcp', enabled_tools: ['read'] } })
  f.sources.claudeUserMcpServers = async () => { throw new Error('Catalog unavailable') }
  await f.fleet.syncChangedSources()
  await settle(computer)
  expect(computer.codexMcp.has('docs')).toBe(true)
  expect(computer.claudeMcp.has('docs')).toBe(true)
  expect(computer.calls.filter(call => call.args[1] === 'remove')).toEqual([])
  await f.fleet.drain()
})
