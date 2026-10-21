import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createInstalledWorkerManagedMcp } from './installedWorkerManagedMcp.js'
import { managedMcpNativeFixture } from '../../../test/helpers/managedMcpNative.js'
import { workerProviderAccountResolver } from '../provider-accounts/workerOperations.js'
import { LocalProviderCredentials } from '../provider-accounts/localCredentials.js'
import { randomUUID } from 'node:crypto'
import { ProviderAccountSchema } from '@foreman-code/contracts/provider-accounts'

vi.mock('./codexMcpConnections.js', async () => {
  const { applyMcpEdits, mcpEdits, fingerprint } = await import('./nativeMcpCommon.js')
  return { CodexMcpConnections: class {
    constructor(_binary: string, _directory: string, _recovery: unknown, _launcher: unknown,
      private readonly environment: NodeJS.ProcessEnv = process.env) {}
    async read() {
      const file = join(this.environment.CODEX_HOME!, 'config.toml')
      const bytes = await readFile(file, 'utf8')
      const user = bytes ? JSON.parse(bytes) : {}
      return { harness: 'codex', file, user, effective: user, userConfig: {}, version: 'native',
        revision: fingerprint(user) }
    }
    async apply(snapshot: never, change: never, _signal: unknown, managed: never) {
      await writeFile((snapshot as { file: string }).file,
        JSON.stringify(applyMcpEdits((snapshot as { user: Record<string, unknown> }).user,
          mcpEdits(snapshot, change, managed))))
    }
  } }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('installs and reads back managed MCP in a newly created selected account without changing the default account', async () => {
  const f = await managedMcpNativeFixture()
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(f.directory, 'mcp'))
  const credentials = new LocalProviderCredentials(join(f.directory, 'slots'))
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, connectionEpoch: 'epoch' }
  const accountId = randomUUID()
  const binding = { kind: 'slot' as const, accountId, provider: 'codex' as const, profileRef: accountId,
    bindingRevision: 1, subject: null, target: { hostRef: { kind: 'device' as const,
      mainId: connection.mainId, deviceId: connection.deviceId }, applicationInstallationId: connection.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1 } }
  const account = ProviderAccountSchema.parse({ id: accountId, provider: 'codex', name: 'Account', authMode: 'subscription',
    isDefault: false, revision: 1, removedAt: null, status: 'signed-in', identity: null, binding })
  await credentials.create(account)
  const { homePath } = credentials.paths(account.id)
  await mkdir(process.env.CODEX_HOME!, { recursive: true })
  await writeFile(join(process.env.CODEX_HOME!, 'config.toml'), '{}')
  const installed = createInstalledWorkerManagedMcp(f.options)
  const accounts = workerProviderAccountResolver({ current: () => connection,
    resolve: async () => ({ account, ...credentials.paths(account.id) }),
    prepareAccount: selected => installed.ensureReady({ account: selected }) })
  try {
    await installed.ensureReady()
    const defaultBefore = await readFile(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8')
    await expect(accounts.resolve('codex', account.id, { acceptedBinding: binding }))
      .resolves.toMatchObject({ accountId: account.id, homePath })
    const user = JSON.parse(await readFile(join(homePath, 'config.toml'), 'utf8'))
    expect(user['foreman-code']).toMatchObject({ command: expect.any(String), args: expect.any(Array) })
    expect(await readFile(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(defaultBefore)
    await expect(accounts.resolve('codex', account.id, { acceptedBinding: binding }))
      .resolves.toMatchObject({ accountId: account.id, homePath })
    expect(JSON.parse(await readFile(join(homePath, 'config.toml'), 'utf8'))).toEqual(user)
  } finally { f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})
