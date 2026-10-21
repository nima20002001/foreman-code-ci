import { expect, it } from 'vitest'
import { ComputerMaintenance } from './maintenance.js'
import { fakeComputer, fakeFleet, settle } from '../../../test/helpers/fleetSync.js'
import { fleetPluginId, versionedComputer } from '../../../test/helpers/fleetPluginVersions.js'

it.each(['codex', 'claude'] as const)('reports unavailable %s stdio paths and retries after destination repair', async harness => {
  const computer = fakeComputer()
  const { fleet, sources } = fakeFleet(computer)
  sources.codexUserMcpServers = async () => ({})
  sources[`${harness}UserMcpServers`] = async () => ({
    local: { command: 'node', args: ['/opt/fixture-tools/server.mjs'] },
  })
  await fleet.syncChangedSources()
  const failed = (await settle(computer)).tasks.find(task => task.kind === 'sync-mcp')!
  expect(failed).toMatchObject({ state: 'failed', summary: expect.stringContaining('unavailable') })
  expect(computer.calls.filter(call => ['add', 'add-json'].includes(call.args[1]!))).toEqual([])
  computer.ports.exists = async path => path === '/opt/fixture-tools/server.mjs'
  const find = computer.ports.find
  computer.ports.find = async name => name === 'node' ? '/fake/node' : find(name)
  await computer.maintenance.start({ kind: 'sync-mcp', servers: {
    [harness]: [{ name: 'local', transport: 'stdio', command: 'node', args: ['/opt/fixture-tools/server.mjs'], envVars: [] }],
  } })
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  computer.ports.exists = async () => false
  await computer.maintenance.start({ kind: 'sync-mcp', servers: {
    [harness]: [{ name: 'local', transport: 'stdio', command: 'node', args: ['/opt/fixture-tools/server.mjs'], envVars: [] }],
  } })
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed', summary: expect.stringContaining('unavailable') })
})

it.each([
  ['/opt/fixture-tools/server', []], ['node', ['--import=/opt/fixture-tools/bootstrap.mjs']],
  ['node', ['./tools/server.mjs']], ['C:\\fixture-tools\\server.exe', []], ['~/tools/server', []],
] as [string, string[]][])('does not install an unresolved stdio path: %s %j', async (command, args) => {
  const computer = fakeComputer()
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [
    { name: 'local', transport: 'stdio', command, args, envVars: [] },
  ] } })
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed', summary: expect.stringContaining('unavailable') })
  expect([...computer.codexMcp]).toEqual([])
})

it.each(['codex', 'claude'] as const)('propagates %s plugin upgrades and preserves unmanaged versions', async harness => {
  const main = versionedComputer()
  main.codexPlugins.add(fleetPluginId)
  main.claudePlugins.set(fleetPluginId, false)
  main.versions.codex.set(fleetPluginId, '1.0.0')
  main.versions.claude.set(fleetPluginId, '1.0.0')
  const worker = versionedComputer()
  worker.codexPlugins.add('local@official')
  worker.claudePlugins.set('local@official', true)
  worker.versions.codex.set('local@official', '0.5.0')
  worker.versions.claude.set('local@official', '0.5.0')
  const { fleet, sources, requested } = fakeFleet(worker)
  Object.assign(sources, main.sources)
  await fleet.syncChangedSources()
  const initial = (await settle(worker)).tasks.find(task => task.kind === 'sync-plugins')!
  expect(initial.state).toBe('succeeded')
  worker.maintenance = new ComputerMaintenance(worker.ports)
  main.versions[harness].set(fleetPluginId, '2.0.0')
  worker.publish('2.0.0')
  await fleet.syncChangedSources()
  const upgraded = (await settle(worker)).tasks.find(task => task.kind === 'sync-plugins')!
  expect(upgraded.sourceFingerprint).not.toBe(initial.sourceFingerprint)
  expect(upgraded.state).toBe('succeeded')
  expect(worker.versions[harness].get(fleetPluginId)).toBe('2.0.0')
  expect(worker.versions[harness].get('local@official')).toBe('0.5.0')
  expect(worker.claudePlugins.get(fleetPluginId)).toBe(false)
  await fleet.syncChangedSources()
  expect(requested.filter(task => task.kind === 'sync-plugins')).toHaveLength(2)
})

it.each(['codex', 'claude'] as const)('fails %s plugin sync when native success retains the old version', async harness => {
  const main = versionedComputer()
  main.codexPlugins.add(fleetPluginId)
  main.claudePlugins.set(fleetPluginId, true)
  main.versions.codex.set(fleetPluginId, '1.0.0')
  main.versions.claude.set(fleetPluginId, '1.0.0')
  const worker = versionedComputer()
  const { fleet, sources } = fakeFleet(worker)
  Object.assign(sources, main.sources)
  await fleet.syncChangedSources()
  expect((await settle(worker)).tasks.find(task => task.kind === 'sync-plugins')?.state).toBe('succeeded')
  main.versions[harness].set(fleetPluginId, '2.0.0')
  worker.retainInstalledVersion()
  await fleet.syncChangedSources()
  expect((await settle(worker)).tasks.find(task => task.kind === 'sync-plugins')).toMatchObject({ state: 'failed' })
})
