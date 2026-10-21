import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createInstalledWorkerManagedMcp } from './installedWorkerManagedMcp.js'
import { managedMcpNativeFixture } from '../../../test/helpers/managedMcpNative.js'
import { DomainError } from '../errors.js'
import { HarnessMcpManagedInputSchema } from '@foreman-code/contracts/management'
import { managedChange } from './nativeMcpCommon.js'

vi.mock('./codexMcpConnections.js', async () => ({
  CodexMcpConnections: (await import('../../../test/helpers/managedMcpNative.js')).ManagedMcpCodexProcess,
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('converges without another managed native session until configuration changes', async () => {
  const f = await managedMcpNativeFixture()
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(f.directory, 'mcp'))
  const installed = createInstalledWorkerManagedMcp(f.options)
  const read = vi.spyOn(f.native.adapter, 'read')
  try {
    await installed.ensureReady()
    read.mockClear()
    await Promise.all(Array.from({ length: 8 }, () => installed.ensureReady()))
    expect(read).not.toHaveBeenCalled()
    expect(f.writes()).toBe(1)
    expect(f.native.owners.size).toBe(0)

    const signal = AbortSignal.timeout(5000)
    await f.adapters.codex.apply(await f.adapters.codex.read(signal), { kind: 'remove', name: 'foreman-code' },
      signal, { preset: 'graphql', endpoint: 'https://app.invalid/mcp' })
    await writeFile(join(process.env.CODEX_HOME!, 'config.toml'), '# Native configuration changed\n')
    await installed.ensureReady()
    expect((await installed.worker.detect('codex', signal)).state).toBe('status_unavailable')
    expect(f.writes()).toBe(3)
  } finally {
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('retries failed native readiness without caching it as ready', async () => {
  const f = await managedMcpNativeFixture()
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(f.directory, 'mcp'))
  const installed = createInstalledWorkerManagedMcp(f.options)
  f.native.failRead = new DomainError('MCP_CONFIG_UNAVAILABLE', 'Native configuration is unavailable.', 503)
  try {
    await expect(installed.ensureReady()).rejects.toMatchObject({ code: 'MCP_CONFIG_UNAVAILABLE' })
    await installed.ensureReady()
    const read = vi.spyOn(f.native.adapter, 'read')
    await installed.ensureReady()
    expect(read).not.toHaveBeenCalled()
    expect(f.writes()).toBe(1)
  } finally {
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('lists repeatedly without sharing the active harness settings process owner', async () => {
  const f = await managedMcpNativeFixture()
  f.native.owners.add('settings:mcp:codex')
  const { worker } = createInstalledWorkerManagedMcp(f.options)
  try {
    for (let request = 0; request < 2; request++) {
      const list = await worker.list('codex', AbortSignal.timeout(5000))
      expect(list.servers.map(server => server.name)).toContain('example')
    }
    expect([...f.native.owners]).toEqual(['settings:mcp:codex'])
  } finally {
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('confirms native closure after failed reads before another listing', async () => {
  const f = await managedMcpNativeFixture()
  const { worker } = createInstalledWorkerManagedMcp(f.options)
  f.native.failRead = new DomainError('MCP_CONFIG_UNAVAILABLE', 'Native configuration is unavailable.', 503)
  try {
    await expect(worker.list('codex', AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ code: 'MCP_CONFIG_UNAVAILABLE' })
    expect(f.native.owners.size).toBe(0)
    expect((await worker.list('codex', AbortSignal.timeout(5000))).servers.map(server => server.name))
      .toContain('example')
    expect(f.native.owners.size).toBe(0)
  } finally {
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('closes each native operation during consecutive managed changes and readback', async () => {
  const f = await managedMcpNativeFixture()
  const signal = AbortSignal.timeout(5000)
  await f.adapters.codex.apply(await f.adapters.codex.read(signal), managedChange('graphql', true, ''),
    signal, { preset: 'graphql', endpoint: 'https://app.invalid/mcp' })
  const { worker } = createInstalledWorkerManagedMcp(f.options)
  try {
    for (const enabled of [false, true]) {
      const input = HarnessMcpManagedInputSchema.parse({ harness: 'codex', preset: 'graphql', enabled })
      const plan = await worker.apply(input, 'operator', signal)
      expect(plan.status).toBe('applied')
      expect((await worker.list('codex', signal)).presets.graphql).toBe(enabled ? 'installed' : 'disabled')
      expect(f.native.owners.size).toBe(0)
    }
  } finally {
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})
