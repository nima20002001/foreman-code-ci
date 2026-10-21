import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { MaintenanceTaskStart, MaintainedHarness } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer, fakeFleet, server, settle } from '../../../test/helpers/fleetSync.js'
import { fleetPluginId, versionedComputer } from '../../../test/helpers/fleetPluginVersions.js'

it.each(['codex', 'claude'] as const)('rejects missing PATH commands for %s without starving portable servers', async harness => {
  const computer = fakeComputer()
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [
    { name: 'missing', transport: 'stdio', command: 'uvx', args: ['some-server'], envVars: [] }, server('docs'),
  ] } })
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed', summary: expect.stringContaining('uvx') })
  expect(computer.codexMcp.has('missing') || computer.claudeMcp.has('missing')).toBe(false)
  expect(harness === 'codex' ? computer.codexMcp.has('docs') : computer.claudeMcp.has('docs')).toBe(true)
})

it.each(['codex', 'claude'] as const)('continues %s synchronization after an unavailable local script', async harness => {
  const computer = fakeComputer()
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [
    { name: 'missing', transport: 'stdio', command: 'node', args: ['/opt/fixture-tools/missing.mjs'], envVars: [] },
    server('docs'),
  ] } })
  expect((await settle(computer)).tasks[0]?.state).toBe('failed')
  expect(harness === 'codex' ? computer.codexMcp.has('docs') : computer.claudeMcp.has('docs')).toBe(true)
})

it.each(['codex', 'claude'] as const)('preserves an independent %s entry before inspecting Main paths', async harness => {
  const computer = fakeComputer()
  const independent = { type: 'http', url: 'https://independent.example/mcp' }
  computer.codexMcp.add('local')
  computer.codexDefinitions.set('local', independent)
  computer.claudeMcp.set('local', independent)
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [
    { name: 'local', transport: 'stdio', command: '/opt/fixture-tools/missing', args: [], envVars: [] }, server('docs'),
  ] } })
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(harness === 'codex' ? computer.codexDefinitions.get('local') : computer.claudeMcp.get('local')).toEqual(independent)
  expect(harness === 'codex' ? computer.codexMcp.has('docs') : computer.claudeMcp.has('docs')).toBe(true)
})

it.each(['codex', 'claude'] as const)('accepts %s container images and package identifiers as arguments', async harness => {
  const computer = fakeComputer()
  const find = computer.ports.find
  computer.ports.find = async name => ['docker', 'npx'].includes(name) ? `/fake/${name}` : find(name)
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [
    { name: 'container', transport: 'stdio', command: 'docker', args: ['run', '--rm', '-i', 'ghcr.io/acme/mcp:latest'], envVars: [] },
    { name: 'package', transport: 'stdio', command: 'npx', args: ['--yes', '@acme/mcp'], envVars: [] },
  ] } })
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(harness === 'codex' ? [...computer.codexMcp] : [...computer.claudeMcp.keys()]).toEqual(['container', 'package'])
})

it('automatically rechecks a persisted success from before destination validation without rewriting history', async () => {
  const computer = fakeComputer()
  const task: MaintenanceTaskStart = { kind: 'sync-mcp', servers: { codex: [
    { name: 'local', transport: 'stdio', command: 'node', args: ['/opt/fixture-tools/missing.mjs'], envVars: [] },
  ], claude: [] } }
  const historical = { id: randomUUID(), kind: 'sync-mcp', sourceFingerprint: commandInputHash(task), state: 'succeeded',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'Already in sync', outputTail: '' }
  computer.files.set('/fake/home/.local/state/foreman-code/maintenance-tasks.json', JSON.stringify([historical]))
  const { fleet, sources, requested } = fakeFleet(computer)
  sources.codexUserMcpServers = async () => ({ local: { command: 'node', args: ['/opt/fixture-tools/missing.mjs'] } })
  await fleet.syncChangedSources()
  const status = await settle(computer)
  expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
  expect(status.tasks.find(task => task.kind === 'sync-mcp')).toMatchObject({ state: 'failed' })
  expect(status.tasks.find(task => task.id === historical.id)).toEqual(historical)
})

async function installedFleet(harness: MaintainedHarness) {
  const computer = versionedComputer()
  const request = (version: string): MaintenanceTaskStart => harness === 'codex'
    ? { kind: 'sync-plugins', plugins: [fleetPluginId], pluginVersions: { [fleetPluginId]: version },
      marketplaces: [{ name: 'official', source: 'owner/official' }] }
    : { kind: 'sync-plugins', claudePlugins: [{ pluginId: fleetPluginId, enabled: false, version }],
      claudeMarketplaces: [{ name: 'official', source: 'owner/official' }] }
  await computer.maintenance.start(request('1.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  return { computer, request }
}

it.each(['codex', 'claude'] as const)('acquires %s upgrades from a fresh catalog before activation', async harness => {
  const { computer, request } = await installedFleet(harness)
  computer.publish('2.0.0')
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(computer.versions[harness].get(fleetPluginId)).toBe('2.0.0')
  expect(harness === 'codex' ? computer.codexPlugins.has(fleetPluginId) : computer.claudePlugins.get(fleetPluginId)).toBe(
    harness === 'codex' ? true : false,
  )
})

it.each(['codex', 'claude'] as const)('preserves a usable %s plugin when acquisition or activation fails', async harness => {
  const { computer, request } = await installedFleet(harness)
  computer.publish('2.0.0')
  computer.failAcquisition()
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('failed')
  expect(computer.versions[harness].get(fleetPluginId)).toBe('1.0.0')
  expect(harness === 'codex' ? computer.codexPlugins.has(fleetPluginId) : computer.claudePlugins.get(fleetPluginId)).toBe(
    harness === 'codex' ? true : false,
  )
  computer.failAcquisition(false)
  computer.fail((binary, args) => binary.endsWith(harness) && args[0] === 'plugin'
    && ['add', 'install', 'update'].includes(args[1]!))
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('failed')
  expect(computer.versions[harness].get(fleetPluginId)).toBe('1.0.0')
  expect(harness === 'codex' ? computer.codexPlugins.has(fleetPluginId) : computer.claudePlugins.get(fleetPluginId)).toBe(
    harness === 'codex' ? true : false,
  )
})

it.each(['codex', 'claude'] as const)('keeps the previous %s installation when the marketplace offers a different release', async harness => {
  const { computer, request } = await installedFleet(harness)
  computer.publish('3.0.0')
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('failed')
  expect(computer.versions[harness].get(fleetPluginId)).toBe('1.0.0')
  expect(harness === 'codex' ? computer.codexPlugins.has(fleetPluginId) : computer.claudePlugins.get(fleetPluginId)).toBe(
    harness === 'codex' ? true : false,
  )
})

it.each((['codex', 'claude'] as const).flatMap(harness =>
  (['failure', 'different-release'] as const).map(fault => [harness, fault] as const))) (
  'restores the previous %s plugin after a native activation %s', async (harness, fault) => {
    const { computer, request } = await installedFleet(harness)
    computer.publish('2.0.0')
    computer.failActivation(fault)
    await computer.maintenance.start(request('2.0.0'))
    expect((await settle(computer)).tasks[0]?.state).toBe('failed')
    expect(computer.versions[harness].get(fleetPluginId)).toBe('1.0.0')
    expect(harness === 'codex' ? computer.codexPlugins.has(fleetPluginId) : computer.claudePlugins.get(fleetPluginId)).toBe(
      harness === 'codex' ? true : false,
    )
  },
)

it('leaves the working Codex release intact when refresh would reinstall a newer unwanted release', async () => {
  const { computer, request } = await installedFleet('codex')
  computer.publish('3.0.0')
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('failed')
  expect(computer.versions.codex.get(fleetPluginId)).toBe('1.0.0')
})

it('updates only the managed Codex plugin while keeping independent marketplace plugins at their installed versions', async () => {
  const { computer, request } = await installedFleet('codex')
  computer.codexPlugins.add('independent@official')
  computer.versions.codex.set('independent@official', '0.5.0')
  computer.publish('2.0.0')
  await computer.maintenance.start(request('2.0.0'))
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(computer.versions.codex.get(fleetPluginId)).toBe('2.0.0')
  expect(computer.versions.codex.get('independent@official')).toBe('0.5.0')
})

it.each((['codex', 'claude'] as const).flatMap(harness => [
  ['node', ['tools/mcp/server.mjs']], ['node', ['--trace-warnings', 'tools/mcp/server.mjs']],
  ['python3', ['-u', 'tools/mcp/server.py']], ['bash', ['tools/mcp/server.sh']],
].map(([command, args]) => ({ harness, command: command as string, args: args as string[] }))))(
  'rejects unresolved $harness interpreter operands: $command $args', async ({ harness, command, args }) => {
    const computer = fakeComputer()
    const find = computer.ports.find
    computer.ports.find = async name => name === command ? `/fake/${command}` : find(name)
    await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [
      { name: 'script', transport: 'stdio', command, args, envVars: [] },
    ] } })
    expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed', summary: expect.stringContaining('unresolved') })
    expect(computer.codexMcp.has('script') || computer.claudeMcp.has('script')).toBe(false)
  },
)

it.each([
  ['node', ['--eval', 'process.stdout.write("a/b")']],
  ['python3', ['-m', 'acme.tools']],
  ['bash', ['-c', 'printf a/b']],
] as [string, string[]][])('preserves interpreter inline and module modes: %s %j', async (command, args) => {
  const computer = fakeComputer()
  const find = computer.ports.find
  computer.ports.find = async name => name === command ? `/fake/${command}` : find(name)
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [
    { name: 'inline', transport: 'stdio', command, args, envVars: [] },
  ] } })
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(computer.codexMcp.has('inline')).toBe(true)
})

it('revalidates retained successes from before interpreter script operands were checked', async () => {
  const computer = fakeComputer()
  const find = computer.ports.find
  computer.ports.find = async name => name === 'node' ? '/fake/node' : find(name)
  const task: MaintenanceTaskStart = { kind: 'sync-mcp', servers: { codex: [
    { name: 'script', transport: 'stdio', command: 'node', args: ['tools/mcp/server.mjs'], envVars: [] },
  ], claude: [] } }
  const historical = { id: randomUUID(), kind: 'sync-mcp',
    sourceFingerprint: commandInputHash({ task, validation: 'destination-executables' }), state: 'succeeded',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'Already in sync', outputTail: '' }
  computer.files.set('/fake/home/.local/state/foreman-code/maintenance-tasks.json', JSON.stringify([historical]))
  const { fleet, sources, requested } = fakeFleet(computer)
  sources.codexUserMcpServers = async () => ({ script: { command: 'node', args: ['tools/mcp/server.mjs'] } })
  await fleet.syncChangedSources()
  const status = await settle(computer)
  expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
  expect(status.tasks.find(task => task.kind === 'sync-mcp')).toMatchObject({ state: 'failed' })
  expect(status.tasks.find(task => task.id === historical.id)).toEqual(historical)
})

it.each(['--env-file', '--env-file-if-exists'])('finds relative scripts after the Node %s value', async option => {
  const computer = fakeComputer()
  const find = computer.ports.find
  computer.ports.find = async name => name === 'node' ? '/fake/node' : find(name)
  computer.ports.exists = async path => path === '/opt/fixture-tools/config.env'
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [
    { name: 'script', transport: 'stdio', command: 'node',
      args: [option, '/opt/fixture-tools/config.env', 'tools/mcp/server.mjs'], envVars: [] },
  ] } })
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed',
    summary: expect.stringContaining('tools/mcp/server.mjs') })
  expect(computer.codexMcp.has('script')).toBe(false)
})

it('preserves a valid Node script after a process title option', async () => {
  const computer = fakeComputer()
  const find = computer.ports.find
  computer.ports.find = async name => name === 'node' ? '/fake/node' : find(name)
  computer.ports.exists = async path => path === '/opt/fixture-tools/server.mjs'
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [
    { name: 'script', transport: 'stdio', command: 'node',
      args: ['--title', 'mcp-server', '/opt/fixture-tools/server.mjs'], envVars: [] },
  ] } })
  expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
  expect(computer.codexMcp.has('script')).toBe(true)
})
