import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it } from 'vitest'
import { harnessBinaries } from './binaries.js'
import { HarnessQualificationRegistry } from './qualification/registry.js'
import { HarnessMcpSettingsService } from './mcpSettings.js'
import type { NativeMcpAdapter } from './nativeMcpCommon.js'
import { initializeNativeDefaults } from './initializeDefaults.js'
import { parseCodexModelCatalog } from './codexModelCatalog.js'
import { passiveDriverPayloads } from './payloadDiscovery.js'
import type { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessCatalogService } from './catalog.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'harness-discovery-'))
  roots.push(root)
  return root
}
const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['harnesses:read'], scope: {} }] }
function mcp(adapter: Partial<NativeMcpAdapter>) {
  return new HarnessMcpSettingsService({} as never, {} as never,
    { codex: adapter as NativeMcpAdapter }, () => undefined)
}

it('propagates unexpected default binary access failures', async () => {
  const root = await directory()
  const loop = join(root, 'loop')
  await symlink(loop, loop)
  expect(() => harnessBinaries({ PATH: loop })).toThrow(expect.objectContaining({ code: 'ELOOP' }))
})

it('reports a rejected default wrapper and the source finally selected', async () => {
  const root = await directory()
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(root, 'package.json'), '{"name":"fixture-wrapper"}')
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  harnessBinaries({ PATH: bin })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'reject default Codex candidate',
    lastError: 'UNRECOGNIZED_CODEX_LAUNCHER', selectedSource: expect.stringMatching(/^(?:bundled-package|command)$/) }))
})

it('does not skip an unreadable qualification candidate', async () => {
  const root = await directory()
  const loop = join(root, 'loop')
  await symlink(loop, loop)
  const registry = new HarnessQualificationRegistry({ list: async () => [], find: async () => null }, {})
  await expect(registry.inspectBinary(join(loop, 'codex'))).rejects.toMatchObject({ code: 'ELOOP' })
})

it('reports native model refresh failure while retaining the validated catalog', () => {
  expect(parseCodexModelCatalog({ exitCode: 0, stdout: '{"models":[]}',
    stderr: 'failed to refresh available models: private provider output' })).toMatchObject({ modelCatalogSource: 'cached' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'refresh native model catalog', dataAgeMs: null }))
  expect(JSON.stringify(readOperationalFailures())).not.toContain('private provider output')
})

it('reports MCP prewarm failures without stopping independent startup', async () => {
  const service = mcp({ read: async () => { throw Object.assign(new Error('Unavailable'), { code: 'EIO' }) } })
  await service.warmup(['codex'])
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'warm MCP discovery' }))
})

it('does not treat an unreadable MCP config stamp as an absent file', async () => {
  const root = await directory()
  const file = join(root, 'loop')
  await symlink(file, file)
  const service = mcp({ read: async () => ({ harness: 'codex', revision: 'revision', file, version: 'fixture',
    userConfig: {}, user: {}, effective: {}, native: [] }) })
  await expect(service.list(principal, 'codex')).rejects.toThrow()
})

it('reports unexpected native default discovery failures while leaving defaults unconfigured', async () => {
  const query = async () => ({ rows: [], rowCount: 1 })
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
  await initializeNativeDefaults({ pool, appMcpEndpoint: 'http://127.0.0.1:3000/mcp',
    options: async () => { throw Object.assign(new Error('Unavailable'), { code: 'EIO' }) } })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'discover native defaults', lastError: 'EIO' }))
})

it('does not turn an unreadable pinned native payload into an incomplete inventory', async () => {
  const root = await directory()
  const launcher = join(root, 'launcher')
  await writeFile(launcher, Buffer.alloc(8790, '#'))
  const native = join(root, 'node_modules', '@openai', 'codex-linux-x64')
  await mkdir(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin'), { recursive: true })
  await writeFile(join(native, 'package.json'), '{}')
  const binary = join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex')
  await symlink(binary, binary)
  const fingerprints = { fingerprint: async () => '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70' } as unknown as PayloadFingerprintCache
  await expect(passiveDriverPayloads('codex', launcher, 'linux', 'x64', fingerprints)).rejects.toMatchObject({ code: 'ELOOP' })
})

it('reports a failed default read before prewarm discovery starts', async () => {
  const failure = Object.assign(new Error('Defaults unavailable'), { code: 'EIO' })
  const service = new HarnessCatalogService({} as never,
    { getManagedHarnessDefaults: async () => { throw failure } } as never, {} as never, '/fixture')
  await expect(service.warmup()).rejects.toBe(failure)
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'load harness prewarm defaults', lastError: 'EIO' }))
})

it('identifies the capability whose native prewarm failed', async () => {
  const service = new HarnessCatalogService({ qualify: async () => { throw new Error('Unavailable') } } as never,
    { getManagedHarnessDefaults: async () => ({ defaults: { codex: { harness: 'codex', model: 'fixture',
      reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' } }, unavailable: [] }) } as never,
    {} as never, '/fixture')
  await service.warmup()
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'warm codex harness discovery' }))
})
