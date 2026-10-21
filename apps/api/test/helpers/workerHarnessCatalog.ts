import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../../src/modules/errors.js'
import { ClaudeBoundedQueue } from '../../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../../src/modules/harnesses/claudeSdk/port.js'

export async function readCatalogLogin(provider: 'codex' | 'claude', environment: NodeJS.ProcessEnv) {
  const directory = provider === 'codex' ? environment.CODEX_HOME : environment.CLAUDE_CONFIG_DIR
  const file = provider === 'codex' ? 'auth.json' : '.credentials.json'
  return JSON.parse(await readFile(join(directory!, file), 'utf8')) as { subject: string | null }
}

export async function catalogCodexQualification(binary: string, _cwd: string, environment: NodeJS.ProcessEnv) {
  if (!(await readCatalogLogin('codex', environment)).subject) throw new DomainError(
    'CODEX_SIGNED_OUT', 'The selected native login is signed out.', 409)
  return { binary, providerVersion: 'codex-cli 0.162.0' }
}

export async function catalogCodexAccount(environment: NodeJS.ProcessEnv) {
  const { subject } = await readCatalogLogin('codex', environment)
  return { account: subject ? { type: 'chatgpt', email: 'reader@example.test', planType: 'plus' } : null,
    requiresOpenaiAuth: true,
    workspaceRouting: subject ? { chatgptAccountId: subject, backendOrigin: 'https://provider.example',
      accountRoutingOverride: 'NO_CONSTRAINT' } : null }
}

export async function catalogCodexModels(_inspection: unknown, _cwd: string, environment: NodeJS.ProcessEnv) {
  const { subject } = await readCatalogLogin('codex', environment)
  return { models: [{ slug: `${subject}-model`, supported_reasoning_levels: [{ effort: 'high' }] }] }
}

export async function catalogClaudeClient(profilePath: string): Promise<ClaudeSdkClient> {
  return { sdkVersion: '0.3.284', query: () => {
    const frames = new ClaudeBoundedQueue<unknown>(10)
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
      initializationResult: async () => {
        const { subject } = await readCatalogLogin('claude', { CLAUDE_CONFIG_DIR: profilePath })
        return { models: subject ? [{ value: `${subject}-model`, supportedEffortLevels: ['high'] }] : [],
          account: { apiProvider: 'firstParty', tokenSource: subject ? 'fixture' : 'none' } }
      }, interrupt: async () => {}, close: () => frames.close(), joinClosed: async () => {} }
  }, getSessionInfo: async () => undefined, getSessionMessages: async () => [],
  forkSession: async () => ({ sessionId: 'unused' }) }
}

export async function workerHarnessCatalogFixture() {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'worker-harness-catalog-'))
  const binary = join(root, 'native')
  await writeFile(binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('native-image-fixture')]),
    { mode: 0o700 })
  const sdk = join(root, 'sdk')
  await mkdir(sdk)
  await writeFile(join(sdk, 'index.mjs'), 'SDK fixture')
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.284' }))
  const lock = join(root, 'installed-lock.yaml')
  await writeFile(lock, "packages:\n  '@anthropic-ai/claude-agent-sdk@0.3.284':\n    resolution: {integrity: sha512-aGVsbG8=}\n")
  const configuration = { path: join(root, 'workflow-runtime.json'), ownerUid: process.getuid!() }
  const selection = { schemaVersion: 1, codexBinary: binary, expectedVersion: 'codex-cli 0.162.0',
    payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs',
    claude: { binary, installedLockPath: lock, sdkEntrypoint: join(sdk, 'index.mjs') } }
  await writeFile(configuration.path, JSON.stringify(selection), { mode: 0o600 })
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const hostRef = { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId }
  const target = { hostRef, applicationInstallationId: connection.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1 }
  const current = vi.fn(() => connection)
  const registry = { reserveLaunch: vi.fn(async (owner: string) => ({ root: join(root, 'processes'), owner })),
    abandonReservedLaunch: vi.fn(async () => {}), closeOwner: vi.fn(async () => true) }
  const homes = { codex: join(root, 'codex-home'), claude: join(root, 'claude-home') }
  for (const directory of Object.values(homes)) await mkdir(directory)
  vi.stubEnv('HOME', root)
  vi.stubEnv('CODEX_HOME', homes.codex)
  vi.stubEnv('CLAUDE_CONFIG_DIR', homes.claude)
  const setLogin = async (provider: 'codex' | 'claude', subject: string | null, directory = homes[provider]) => {
    await mkdir(directory, { recursive: true })
    const file = join(directory, provider === 'codex' ? 'auth.json' : '.credentials.json')
    const pending = `${file}.${randomUUID()}`
    await writeFile(pending, JSON.stringify({ subject }), { mode: 0o600 })
    await rename(pending, file)
  }
  await setLogin('codex', 'first')
  await setLogin('claude', 'first')
  const managed = async (provider: 'codex' | 'claude') => {
    const accountId = randomUUID()
    const homePath = join(root, 'managed', accountId, 'home')
    await setLogin(provider, 'managed', homePath)
    const binding: ProviderAccountBinding = { kind: 'slot', accountId, provider, target,
      profileRef: accountId, bindingRevision: 1, subject: null }
    const account = { id: accountId, provider, name: 'Managed account', authMode: 'subscription' as const,
      isDefault: false, revision: 1, status: 'signed-in' as const, identity: null, removedAt: null, binding }
    const file = join(root, 'managed-account.json')
    await writeFile(file, JSON.stringify(account), { mode: 0o600 })
    return { binding, account, homePath, file }
  }
  const pairing = { formatVersion: 1 as const, ...connection, endpoint: 'wss://worker.example/connect',
    mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  return { root, configuration, selection, connection, target, hostRef, current, registry, homes, setLogin, managed, pairing,
    input: { stateDirectory: root, configuration, current, registry: registry as never },
    request: (harness: 'codex' | 'claude') => ({ operation: 'options' as const, harness, target }),
    context: (signal = new AbortController().signal) => ({ binding: connection, signal }),
    close: () => rm(root, { recursive: true, force: true }) }
}
