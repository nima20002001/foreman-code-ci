import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaintenanceRequestSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance, systemMaintenancePorts } from '../src/modules/computers/maintenance.js'
import { syncableServers } from '../src/modules/computers/fleet.js'
import { fakeComputer, fakeFleet, mcpRequest, pluginRequest, server, settle } from './helpers/fleetSync.js'

describe('fleet source propagation', () => {
  it('distinguishes an absent native catalog from a failed file read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-source-'))
    const ports = systemMaintenancePorts()
    try {
      expect(await ports.readText(join(directory, 'missing.json'))).toBeNull()
      await expect(ports.readText(directory)).rejects.toMatchObject({ code: 'EISDIR' })
      const file = join(directory, 'catalog.json')
      await writeFile(file, '{}')
      expect(await ports.readText(file)).toBe('{}')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('skips and reports inline credentials without passing them to receiver commands', async () => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexUserMcpServers = async () => ({
      safe: { url: 'https://service.example/mcp', bearer_token_env_var: 'SERVICE_TOKEN' },
      query: { url: 'https://service.example/mcp?api_key=fixture-secret' },
      userinfo: { url: 'https://owner:fixture-secret@service.example/mcp' },
      argument: { command: '/usr/bin/server', args: ['--api-key=fixture-secret'] },
      separate: { command: '/usr/bin/server', args: ['--api-key', 'fixture-secret'] },
      bearer: { command: '/usr/bin/server', args: ['Authorization: Bearer fixture-secret'] },
    })
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect([...computer.codexMcp]).toEqual(['safe'])
    expect(JSON.stringify(requested)).not.toContain('fixture-secret')
    expect(JSON.stringify(computer.calls)).not.toContain('fixture-secret')
    const summary = status.tasks.find(task => task.kind === 'sync-mcp')?.summary
    const skipped = ['query', 'userinfo', 'argument', 'separate', 'bearer']
    expect(requested.find(task => task.kind === 'sync-mcp')?.warnings).toEqual(
      skipped.map(name => `codex MCP server ${name} is unsafe or invalid; skipped.`))
    for (const name of skipped) expect(summary).toContain(name)
    expect(syncableServers({ tool: { command: 'npx', args: ['server', '--token-env-var', 'SERVICE_TOKEN'] } }))
      .toHaveLength(1)
  })

  it.each([
    { enabled: false }, { enabled_tools: ['read'] }, { enabled_tools: [] }, { disabled_tools: ['write'] },
    { env_vars: ['REMOTE_TOKEN'] },
  ])('reports unsupported settings without copying a less restricted definition: %j', settings => {
    const skipped: string[] = []
    expect(syncableServers({ restricted: { command: 'server', ...settings } }, name => { skipped.push(name) }))
      .toEqual([])
    expect(skipped).toEqual(['restricted'])
  })

  it.each(['codex', 'claude'] as const)('preserves %s MCP when its source is unreadable', async harness => {
    const computer = fakeComputer()
    const { fleet, sources } = fakeFleet(computer)
    sources.claudeUserMcpServers = async () => ({ docs: { url: 'https://docs.example/mcp' } })
    await fleet.syncChangedSources()
    await settle(computer)
    sources.codexUserMcpServers = async () => ({})
    sources.claudeUserMcpServers = async () => ({})
    sources[`${harness}UserMcpServers`] = async () => { throw new Error('Native discovery timeout') }
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect(computer.codexMcp.has('docs')).toBe(harness === 'codex')
    expect(computer.claudeMcp.has('docs')).toBe(harness === 'claude')
    expect(status.tasks[0]?.summary).toContain('could not be read')
    sources[`${harness}UserMcpServers`] = async () => ({})
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual([])
    expect([...computer.claudeMcp]).toEqual([])
  })

  it.each(['codex', 'claude'] as const)('preserves skipped %s definitions and still removes genuinely deleted servers', async harness => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    const source = `${harness}UserMcpServers` as const
    sources.codexUserMcpServers = async () => ({})
    sources.claudeUserMcpServers = async () => ({})
    sources[source] = async () => ({ kept: { url: 'https://kept.example/mcp' }, deleted: { url: 'https://deleted.example/mcp' } })
    await fleet.syncChangedSources()
    await settle(computer)
    for (const definition of [
      { url: 'https://kept.example/mcp', env: { TOKEN: 'private-value' } },
      { url: 'https://kept.example/mcp', http_headers: { Authorization: 'private-value' } },
      { url: 'https://kept.example/mcp', enabled: false },
      { url: 'https://kept.example/mcp', enabled_tools: ['read'] },
      { url: 'https://kept.example/mcp', enabled_tools: [] },
      { url: 'https://kept.example/mcp', disabled_tools: ['write'] },
      { command: 'server', env_vars: ['REMOTE_TOKEN'] },
    ]) {
      sources[source] = async () => ({ kept: definition })
      await fleet.syncChangedSources()
      const status = await settle(computer)
      expect(status.tasks.find(task => task.kind === 'sync-mcp')?.summary).toContain('kept')
      const names = harness === 'codex' ? [...computer.codexMcp] : [...computer.claudeMcp.keys()]
      expect(names).toEqual(['kept'])
      const task = requested.filter(task => task.kind === 'sync-mcp').at(-1)!
      expect(task).toMatchObject({ servers: { [harness]: [] }, skippedServers: { [harness]: ['kept'] } })
      expect(JSON.stringify(task)).not.toContain('private-value')
      computer.maintenance = new ComputerMaintenance(computer.ports)
    }
    expect(computer.calls.filter(call => call.args[1] === 'remove' && call.args.includes('kept'))).toEqual([])
    sources[source] = async () => ({})
    await fleet.syncChangedSources()
    await settle(computer)
    expect(harness === 'codex' ? [...computer.codexMcp] : [...computer.claudeMcp.keys()]).toEqual([])
  })

  it.each(['codex', 'claude'] as const)('preserves %s plugins when its source is unreadable', async harness => {
    const computer = fakeComputer()
    const { fleet, sources } = fakeFleet(computer)
    sources.codexPlugins = async () => [{ pluginId: 'notes@official', version: null }]
    sources.claudePlugins = async () => ({ plugins: [{ pluginId: 'notes@official', installed: true,
      enabled: true, name: 'notes', marketplaceName: 'official', description: null,
      version: null, installCount: null }], marketplaces: [] })
    await fleet.syncChangedSources()
    await settle(computer)
    sources.codexPlugins = async () => []
    sources.claudePlugins = async () => ({ plugins: [], marketplaces: [] })
    if (harness === 'codex') sources.codexPlugins = async () => { throw new Error('Catalog unavailable') }
    else sources.claudePlugins = async () => { throw new Error('Catalog unavailable') }
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect(computer.codexPlugins.has('notes@official')).toBe(harness === 'codex')
    expect(computer.claudePlugins.has('notes@official')).toBe(harness === 'claude')
    expect(status.tasks.find(task => task.kind === 'sync-plugins')?.summary).toContain('could not be read')
  })

  it('backs off failed background work across Main restarts and retries after the delay', async () => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const { fleet, sources, requested, createFleet } = fakeFleet(computer, () => now)
    sources.codexPlugins = async () => [{ pluginId: 'notes@official', version: null }]
    computer.fail((binary, args) => binary.endsWith('codex') && args[0] === 'plugin' && args[1] === 'add')
    await fleet.syncChangedSources()
    expect((await settle(computer)).tasks.find(task => task.kind === 'sync-plugins')?.state).toBe('failed')
    computer.fail(() => false)
    await fleet.syncChangedSources()
    await createFleet().syncChangedSources()
    expect(requested.filter(task => task.kind === 'sync-plugins')).toHaveLength(1)
    now += 5 * 60_000
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexPlugins]).toEqual(['notes@official'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    expect(requested.filter(task => task.kind === 'sync-plugins')).toHaveLength(2)
    await fleet.syncChangedSources()
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(3)
  })

  it('waits for matching completion and retries an interrupted Worker task', async () => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const originalRead = computer.ports.readText
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    computer.ports.readText = async path => {
      if (path.endsWith('fleet-sync.json')) await gate
      return originalRead(path)
    }
    const { fleet, requested } = fakeFleet(computer, () => now)
    await fleet.syncChangedSources()
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(2)
    const original = computer.maintenance
    computer.maintenance = new ComputerMaintenance(computer.ports)
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(2)
    now += 5 * 60_000
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(4)
    release()
    await settle({ ...computer, maintenance: original })
    await settle(computer)
  })

  it('caps repeated failures at hourly retries and shares concurrent automatic dispatches', async () => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const { fleet, requested } = fakeFleet(computer, () => now)
    computer.fail((_binary, args) => args[0] === 'mcp' && args[1] === 'list')
    await Promise.all([fleet.syncChangedSources(), fleet.syncChangedSources(), fleet.keepCurrent()])
    await settle(computer)
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      const count = requested.filter(task => task.kind === 'sync-mcp').length
      for (let tick = 1; tick < minutes; tick++) {
        now += 60_000
        await fleet.syncChangedSources()
      }
      expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(count)
      now += 60_000
      await fleet.syncChangedSources()
      await settle(computer)
      expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(count + 1)
    }
  })

  it.each([-60, 60])('backs off with a Worker clock offset of %i minutes', async offset => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now + offset * 60_000)
    const { fleet, createFleet, requested } = fakeFleet(computer, () => now)
    computer.fail((_binary, args) => args[0] === 'mcp' && args[1] === 'list')
    await fleet.syncChangedSources()
    await settle(computer)
    for (let tick = 0; tick < 4; tick++) {
      now += 60_000
      await createFleet().syncChangedSources()
    }
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    now += 60_000
    await fleet.syncChangedSources()
    await settle(computer)
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(2)
  })

  it('retries an unanswered dispatch with the same command ID without duplicating accepted work', async () => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const { fleet, requested, endpoint } = fakeFleet(computer, () => now)
    const request = endpoint.request
    let loseReply = true
    endpoint.request = async (device, namespace, payload) => {
      const result = await request(device, namespace, payload)
      if (MaintenanceRequestSchema.parse(payload).operation === 'start' && loseReply) {
        loseReply = false
        throw new Error('Reply lost')
      }
      return result
    }
    await fleet.syncChangedSources()
    await settle(computer)
    now += 5 * 60_000
    await fleet.syncChangedSources()
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    expect(computer.calls.filter(call => call.args[0] === 'mcp' && call.args[1] === 'add')).toHaveLength(1)
  })

  it('reports secret-bearing Claude servers as skipped in a successful persisted sync', async () => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexUserMcpServers = async () => ({})
    sources.claudeUserMcpServers = async () => ({
      private: { type: 'http', url: 'https://private.example/mcp', headers: { Authorization: 'Bearer fixture-secret' } },
    })
    await fleet.syncChangedSources()
    await settle(computer)
    computer.maintenance = new ComputerMaintenance(computer.ports)
    const status = await computer.maintenance.status(AbortSignal.timeout(1000))
    expect(status.tasks.find(task => task.kind === 'sync-mcp')).toMatchObject({
      state: 'succeeded', summary: expect.stringContaining('contains credentials; configure it separately'),
    })
    expect(status.tasks.find(task => task.kind === 'sync-mcp')?.summary).toContain('skipped')
    expect(JSON.stringify(requested)).not.toContain('fixture-secret')
    expect(computer.calls.some(call => call.args[0] === 'mcp')).toBe(false)
    await fleet.syncChangedSources()
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
  })

  it.each(['sync-mcp', 'sync-plugins'] as const)('tracks a queued %s task through persisted completion', async kind => {
    const computer = fakeComputer()
    const read = computer.ports.readText
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    computer.ports.readText = async path => {
      if (path.endsWith('fleet-sync.json')) await gate
      return read(path)
    }
    const older = await computer.maintenance.start(kind === 'sync-mcp'
      ? mcpRequest(['old']) : pluginRequest(['old@official']))
    const { fleet, requested, sources } = fakeFleet(computer)
    sources.codexPlugins = async () => [{ pluginId: 'notes@official', version: null }]
    try {
      await fleet.syncChangedSources()
      const status = await computer.maintenance.status(AbortSignal.timeout(1000))
      const queued = status.tasks.find(task => task.kind === kind && task.id !== older.id)!
      expect(queued).toMatchObject({ state: 'running', summary: 'Waiting for the previous task…' })
      expect(queued.sourceFingerprint).toMatch(/^sha256:/u)
      expect(queued.sourceFingerprint).not.toBe(older.sourceFingerprint)
      await fleet.syncChangedSources()
      expect(requested).toHaveLength(2)
      release()
      await settle(computer)
      computer.maintenance = new ComputerMaintenance(computer.ports)
      const persisted = await computer.maintenance.status(AbortSignal.timeout(1000))
      expect(persisted.tasks.find(task => task.id === queued.id)).toMatchObject({
        state: 'succeeded', sourceFingerprint: queued.sourceFingerprint,
      })
      await fleet.syncChangedSources()
      await fleet.syncChangedSources()
      expect(requested).toHaveLength(2)
      expect([...computer.codexMcp]).toEqual(['docs'])
      expect([...computer.claudeMcp]).toEqual([])
      expect([...computer.codexPlugins]).toEqual(['notes@official'])
      expect([...computer.claudePlugins]).toEqual([])
    } finally {
      release()
      await settle(computer)
    }
  })

  it('acknowledges plugin sources when receiver validation changes property order', async () => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexPlugins = async () => [{ pluginId: 'notes@official', version: null }]
    sources.codexMarketplaces = async () => [{ source: 'owner/official', name: 'official' }]
    await fleet.syncChangedSources()
    await settle(computer)
    sources.codexMarketplaces = async () => [{ name: 'official', source: 'owner/official' }]
    await fleet.syncChangedSources()
    await settle(computer)
    await fleet.syncChangedSources()
    expect([...computer.codexPlugins]).toEqual(['notes@official'])
    expect(requested.filter(task => task.kind === 'sync-plugins')).toHaveLength(1)
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
  })

  it('does not acknowledge an older source task, even with a fast receiver clock', async () => {
    const computer = fakeComputer()
    computer.ports.now = () => new Date('2099-01-01T00:00:00.000Z')
    const originalRead = computer.ports.readText
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    computer.ports.readText = async path => {
      if (path.endsWith('fleet-sync.json')) await gate
      return originalRead(path)
    }
    const older = await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [server('old')], claude: [] } })
    const { fleet, requested, endpoint } = fakeFleet(computer)
    const workerRequest = endpoint.request
    // An older receiver reply must not acknowledge Main's current sources.
    endpoint.request = async (device, namespace, payload) => {
      const request = MaintenanceRequestSchema.parse(payload)
      if (request.operation === 'start' && request.task.kind === 'sync-mcp') {
        requested.push(request.task)
        return { payload: { operation: 'start', task: older } }
      }
      return workerRequest(device, namespace, payload)
    }
    await fleet.syncChangedSources()
    endpoint.request = workerRequest
    release()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['old'])
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['docs'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(2)
  })

  it.each(['mcp', 'plugins'] as const)('propagates other catalogs when all %s sources fail', async kind => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    if (kind === 'plugins') {
      sources.codexPlugins = async () => { throw new Error('Plugin discovery timeout') }
      sources.claudePlugins = async () => { throw new Error('Plugin discovery timeout') }
    } else {
      sources.codexUserMcpServers = async () => { throw new Error('MCP discovery timeout') }
      sources.claudeUserMcpServers = async () => { throw new Error('MCP discovery timeout') }
      sources.codexPlugins = async () => [{ pluginId: 'notes@official', version: null }]
    }
    await expect(fleet.syncChangedSources()).rejects.toThrow('Some fleet settings could not be read')
    await settle(computer)
    expect(requested.map(task => task.kind)).toEqual([kind === 'plugins' ? 'sync-mcp' : 'sync-plugins'])
    if (kind === 'plugins') expect([...computer.codexMcp]).toEqual(['docs'])
    else expect([...computer.codexPlugins]).toEqual(['notes@official'])
  })

  it('keeps readable Claude plugins in background upkeep when Codex discovery fails', async () => {
    const computer = fakeComputer()
    computer.codexPlugins.add('local@official')
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexPlugins = async () => { throw new Error('Codex plugin catalog unavailable') }
    sources.claudePlugins = async () => ({ marketplaces: [], plugins: [{
      pluginId: 'notes@official', name: 'notes', marketplaceName: 'official', description: null, version: null,
      installed: true, enabled: true, installCount: null,
    }] })
    await expect(fleet.keepCurrent()).resolves.toBeUndefined()
    await settle(computer)
    expect(requested.find(task => task.kind === 'sync-plugins')).toEqual({
      kind: 'sync-plugins', claudePlugins: [{ pluginId: 'notes@official', enabled: true }],
      claudeMarketplaces: [], warnings: ['Codex plugin catalog could not be read; skipped.'],
    })
    expect([...computer.codexMcp]).toEqual(['docs'])
    expect([...computer.codexPlugins]).toEqual(['local@official'])
    expect([...computer.claudePlugins]).toEqual([['notes@official', true]])
  })

  it('reports complete plugin discovery failure after dispatching background harness updates and MCP sync', async () => {
    const computer = fakeComputer()
    const readStatus = computer.maintenance.status.bind(computer.maintenance)
    computer.maintenance.status = async signal => {
      const status = await readStatus(signal)
      return { ...status, harnesses: status.harnesses.map(entry => ({ ...entry, latest: '9.0.0' })) }
    }
    const { fleet, sources, requested, registrations } = fakeFleet(computer)
    const [worker] = registrations.splice(0)
    sources.codexPlugins = async () => { throw new Error('Codex plugin catalog unavailable') }
    sources.claudePlugins = async () => { throw new Error('Claude plugin catalog unavailable') }
    await expect(fleet.keepCurrent()).rejects.toThrow('Some fleet settings could not be read.')
    const mainOnly = await settle(computer)
    expect(mainOnly.tasks.map(task => task.kind)).toEqual(['update-harnesses'])
    expect(requested).toEqual([])
    expect([...computer.codexMcp]).toEqual([])
    registrations.push(worker!)
    await expect(fleet.keepCurrent()).rejects.toThrow('Some fleet settings could not be read.')
    await settle(computer)
    expect(requested.map(task => task.kind)).toEqual(['update-harnesses', 'sync-mcp'])
    expect(requested[0]).toEqual({ kind: 'update-harnesses', harnesses: ['codex', 'claude'] })
    expect([...computer.codexMcp]).toEqual(['docs'])
  })
})


it.each(['http://127.0.0.1:9000/mcp', 'http://127.9.8.7/mcp', 'http://localhost:9000/mcp',
  'http://[::1]:9000/mcp', 'http://0.0.0.0:9000/mcp', 'http://[::]:9000/mcp',
  'http://service.localhost:9000/mcp'])('keeps host-local MCP endpoint %s out of fleet copies', url => {
  const skipped: string[] = []
  expect(syncableServers({ local: { url }, shared: { url: 'https://shared.example/mcp' } },
    name => { skipped.push(name) })).toEqual([
    { transport: 'http', name: 'shared', url: 'https://shared.example/mcp', bearerTokenEnvVar: null },
  ])
  expect(skipped).toEqual(['local'])
})
