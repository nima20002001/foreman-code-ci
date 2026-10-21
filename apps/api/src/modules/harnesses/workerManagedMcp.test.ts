import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorkerManagedMcp } from './workerManagedMcp.js'
import { deviceManagedMcpFixture } from '../../../test/helpers/deviceManagedMcp.js'
import { APP_MCP_TIMEOUTS, appLauncherConnection } from './appMcpLauncher.js'
import { nativeConnection } from './nativeMcpCommon.js'
import { remoteMcpPreflight } from '../placement/remoteMcpPreflight.js'
import { safeEnvironment } from './codexAppServer.js'

it.each([
  ['graphql', 'GRAPHQL_MCP_TOKEN'],
  ['foreman-code', 'FOREMAN_CODE_MCP_TOKEN'],
] as const)('preflights the configured %s launcher and injects its scoped token', async (name, tokenName) => {
  const f = await deviceManagedMcpFixture()
  const signal = AbortSignal.timeout(5000)
  await writeFile(join(f.directory, 'codex.json'), JSON.stringify({
    [name]: nativeConnection({ ...appLauncherConnection(), environmentVariables: [tokenName] }),
  }))
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  const manager = { harness: 'codex', inspectMcp: () => worker.detect('codex', signal),
    capabilities: async () => ({ provider: 'codex', providerVersion: 'fixture' }) }
  const input = { harness: 'codex' as const, runnerId: 'paired-worker', workingDirectory: f.directory }
  const preflight = remoteMcpPreflight(manager as unknown as Parameters<typeof remoteMcpPreflight>[0],
    input as unknown as Parameters<typeof remoteMcpPreflight>[1])
  try {
    expect((await preflight.preflight(input)).detection).toMatchObject({
      serverName: name, credentialEnvironmentVariable: tokenName, state: 'status_unavailable',
    })
    await worker.ensureReady(['codex'])
    expect((await preflight.preflight(input)).detection).toMatchObject({
      serverName: 'foreman-code', credentialEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN',
    })
    const environment = safeEnvironment({ agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'scoped-fixture-token' } })
    expect(environment.FOREMAN_CODE_MCP_TOKEN).toBe('scoped-fixture-token')
    expect(environment.GRAPHQL_MCP_TOKEN).toBe('scoped-fixture-token')
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it.each([true, false])('migrates an enabled=%s product launcher while preserving native policies', async enabled => {
  const f = await deviceManagedMcpFixture()
  const signal = AbortSignal.timeout(5000)
  const legacy = { ...nativeConnection({ ...appLauncherConnection(), environmentVariables: ['GRAPHQL_MCP_TOKEN'] }),
    enabled, disabled_tools: ['interaction_respond'] }
  await writeFile(join(f.directory, 'codex.json'), JSON.stringify({
    graphql: legacy, example: { url: 'https://example.test/mcp' },
  }))
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    await worker.ensureReady(['codex'])
    const native = await f.adapters.codex.read(signal)
    expect(native.user.graphql).toBeUndefined()
    expect(native.user['foreman-code']).toMatchObject({ enabled, env_vars: ['FOREMAN_CODE_MCP_TOKEN'],
      disabled_tools: ['interaction_respond'] })
    expect(native.user.example).toEqual({ url: 'https://example.test/mcp' })
    expect((await worker.detect('codex', signal)).state).toBe(enabled ? 'status_unavailable' : 'disabled')
    await worker.ensureReady(['codex'])
    expect(f.writes()).toBe(1)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('migrates a legacy token reference under the canonical server name', async () => {
  const f = await deviceManagedMcpFixture()
  const connection = nativeConnection({ ...appLauncherConnection(), environmentVariables: ['GRAPHQL_MCP_TOKEN'] })
  await writeFile(join(f.directory, 'codex.json'), JSON.stringify({ 'foreman-code': connection }))
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    await worker.ensureReady(['codex'])
    expect((await f.adapters.codex.read(AbortSignal.timeout(5000))).user['foreman-code'])
      .toMatchObject({ env_vars: ['FOREMAN_CODE_MCP_TOKEN'] })
    expect(f.writes()).toBe(1)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it.each([
  { enabled: true, startup_timeout_sec: 60, tool_timeout_sec: 120 },
  { enabled: false, startup_timeout_sec: 60, tool_timeout_sec: 120 },
  { enabled: true, startup_timeout_sec: 30, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec },
  { enabled: true, startup_timeout_sec: undefined, tool_timeout_sec: undefined },
])('updates outdated managed timeouts before Worker readiness: %j', async settings => {
  const f = await deviceManagedMcpFixture()
  const connection = { ...nativeConnection(appLauncherConnection()), ...settings,
    disabled_tools: ['interaction_respond'] }
  await writeFile(join(f.directory, 'codex.json'), JSON.stringify({
    'foreman-code': connection, example: { url: 'https://example.test/mcp' },
  }))
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    await worker.ensureReady(['codex'])
    const native = await f.adapters.codex.read(AbortSignal.timeout(5000))
    expect(native.user['foreman-code']).toEqual({ ...connection, ...APP_MCP_TIMEOUTS })
    expect(native.user.example).toEqual({ url: 'https://example.test/mcp' })
    expect(f.writes()).toBe(1)
    await worker.ensureReady(['codex'])
    expect(f.writes()).toBe(1)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('refuses to report readiness for a customized product connection', async () => {
  const f = await deviceManagedMcpFixture()
  await writeFile(join(f.directory, 'codex.json'), JSON.stringify({
    'foreman-code': { url: 'https://custom.example.test/mcp' },
  }))
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    await expect(worker.ensureReady(['codex'])).rejects.toMatchObject({ code: 'APP_MCP_SETUP_FAILED' })
    expect(f.writes()).toBe(0)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('installs and repairs managed MCP before a paired device becomes an Agent host', async () => {
  const f = await deviceManagedMcpFixture()
  const installLauncher = vi.fn(async () => {})
  const open = () => new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher })
  try {
    const worker = open()
    await worker.ensureReady(['codex', 'claude'])
    for (const harness of ['codex', 'claude'] as const) {
      const list = await worker.list(harness, AbortSignal.timeout(5000))
      expect(list.presets?.graphql).toBe('installed')
      expect(list.servers.map(server => server.name)).toEqual(expect.arrayContaining(['example', 'foreman-code']))
    }
    expect(f.writes()).toBe(2)
    await open().ensureReady(['codex', 'claude'])
    expect(f.writes()).toBe(2)
    const signal = AbortSignal.timeout(5000)
    await f.adapters.codex.apply(await f.adapters.codex.read(signal), { kind: 'remove', name: 'foreman-code' },
      signal, { preset: 'graphql', endpoint: 'https://app.invalid/mcp' })
    await open().ensureReady(['codex', 'claude'])
    expect((await open().list('codex', signal)).presets?.graphql).toBe('installed')
    expect(f.writes()).toBe(4)
    expect(installLauncher).toHaveBeenCalled()
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('retains disabled policies and never replays an uncertain device write', async () => {
  const f = await deviceManagedMcpFixture()
  const signal = AbortSignal.timeout(5000)
  const input = { harness: 'codex' as const, preset: 'graphql' as const, installed: true, commandId: 'managed-install' }
  const open = () => new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    const plan = await open().apply(input, 'operator', signal)
    expect(await open().apply(input, 'operator', signal)).toEqual(plan)
    expect(f.writes()).toBe(1)
    await open().apply({ harness: 'codex', preset: 'graphql', enabled: false, commandId: 'managed-disable' }, 'operator', signal)
    await open().ensureReady(['codex'])
    expect((await open().list('codex', signal)).presets?.graphql).toBe('disabled')
    const failing = new WorkerManagedMcp({ directory: f.directory, installLauncher: async () => {},
      adapters: { ...f.adapters, claude: { ...f.adapters.claude, apply: async () => { throw new Error('Lost reply') } } } })
    const uncertain = await failing.apply({ ...input, harness: 'claude' }, 'operator', signal)
    expect(uncertain.status).toBe('uncertain')
    expect(await open().apply({ ...input, harness: 'claude' }, 'operator', signal)).toEqual(uncertain)
    expect((await open().list('claude', signal)).presets?.graphql).toBe('missing')
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('rejects a changed paired-device binding before the Worker writes native configuration', async () => {
  const f = await deviceManagedMcpFixture()
  const { randomUUID } = await import('node:crypto')
  const { createWorkerManagedMcpExtension } = await import('./workerManagedMcp.js')
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const binding = { mainId, deviceId, workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  const extension = createWorkerManagedMcpExtension(worker, () => ({ ...binding, authorizationRevision: 2 }))
  try {
    await expect(extension.handle!({
      target: { hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: binding.workerInstallationId,
        keyRevision: 1, authorizationRevision: 1 },
      request: { operation: 'apply', requestedBy: 'operator', input: { harness: 'codex', preset: 'graphql',
        installed: true, commandId: 'stale-device-install' } },
    }, { binding, signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ code: 'MCP_INSPECTION_CONTEXT_MISMATCH' })
    expect(f.writes()).toBe(0)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('unblocks the public Agent preflight when readiness installs a missing native MCP entry', async () => {
  const f = await deviceManagedMcpFixture()
  const { remoteMcpPreflight } = await import('../placement/remoteMcpPreflight.js')
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  const manager = { harness: 'codex', inspectMcp: () => worker.detect('codex', AbortSignal.timeout(5000)),
    capabilities: async () => ({ provider: 'codex', providerVersion: 'fixture' }) }
  const input = { harness: 'codex' as const, runnerId: 'worker', workingDirectory: f.directory }
  const preflight = remoteMcpPreflight(manager as unknown as Parameters<typeof remoteMcpPreflight>[0],
    input as unknown as Parameters<typeof remoteMcpPreflight>[1])
  try {
    await expect(preflight.preflight(input)).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    await worker.ensureReady(['codex'])
    expect(await preflight.preflight(input)).toMatchObject({ detection: {
      state: 'status_unavailable', endpointMatches: true, credentialEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN',
    } })
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
