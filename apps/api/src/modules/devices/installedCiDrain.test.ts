import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'
import { deviceApplicationFailure } from './deviceApplicationError.js'

const preparation = vi.hoisted(() => ({ root: '', pause: async () => {}, launches: 0, failSource: false }))
vi.mock('../ci-host/runner.js', async original => {
  const actual = await original<typeof import('../ci-host/runner.js')>()
  return { ...actual, HostCiRunner: class extends actual.HostCiRunner {
    constructor() {
      super(join(preparation.root, 'host-ci'), { cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
        run: async (file, args) => {
          if (file === 'git' && args.includes('worktree') && args.includes('add')) {
            await preparation.pause()
            await mkdir(args.at(-2)!, { recursive: true })
            await writeFile(join(args.at(-2)!, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
          }
          if (file === 'systemd-run') preparation.launches++
          return { code: 0, stdout: file === 'systemctl' ? 'active' : '', stderr: '' }
        } }, {})
    }
  } }
})
vi.mock('../jobs/ciRuntimeWorker.js', async original => {
  const actual = await original<typeof import('../jobs/ciRuntimeWorker.js')>()
  return { ...actual, CiRuntimeWorker: class extends actual.CiRuntimeWorker {
    constructor(...[directory, ports, signal]: ConstructorParameters<typeof actual.CiRuntimeWorker>) {
      super(directory, { ...ports,
        git: { cloneDirectory: () => preparation.root, git: async args => {
          const failed = preparation.failSource && ['cat-file', 'fetch'].includes(args[0]!)
          return { code: failed ? 1 : 0, stdout: '', stderr: failed ? 'Fixture source is unavailable.' : '' }
        } },
        managedRuntimeRoot: async () => preparation.root,
        currentRuntimePaths: async () => [],
        prepare: async request => {
          await preparation.pause()
          return { commit: request.commit, imageId: `sha256:${'a'.repeat(64)}`,
            imageManifestDigest: `sha256:${'b'.repeat(64)}`, qualificationSource: join(preparation.root, 'source'),
            seedReceiptPath: join(preparation.root, 'seed.json'), contextReceiptPath: join(preparation.root, 'context.json') }
        },
      }, signal)
    }
  } }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(storage, 'installed-ci-update-'))
  roots.push(root)
  preparation.root = root
  preparation.launches = 0
  preparation.failSource = false
  let entered = false
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  preparation.pause = async () => { entered = true; await released }
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://fixture.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const options = { stateDirectory: root, pairing, bootId: binding.bootId, configuration: null,
    approvedRoots: async () => null, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, captureRequest: () => undefined, mainNow: () => Date.now() }) }
  const mounted = await createInstalledWorkerDomains(options)
  const context = { binding, signal: AbortSignal.timeout(10_000) }
  const handle = (namespace: string, payload: unknown) =>
    mounted.extensions.find(extension => extension.namespace === namespace)!.handle!(payload, context)
  return { root, pairing, mounted, options, context, handle, preparationEntered: () => entered, release }
}

async function updater(f: Awaited<ReturnType<typeof fixture>>) {
  // The shipped updater runs its normal download and staging sequence against a fixture release.
  const { WorkerUpdater } = await import(new URL('../../../../worker/src/update.mjs', import.meta.url).href)
  const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
    rootPersistent: true, homePersistent: true, storagePersistent: true }
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const bytes = Buffer.from('fixture')
  const { os, osRelease, arch, libc, node } = facts
  const manifest = { format: 1, version: '1.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: hash(bytes) }] }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const release = { version: manifest.version, manifest, manifestSha256: hash(manifestBytes),
    github: { repository: 'example/worker', tag: `worker-${manifest.commit}` } }
  const activity: string[] = []
  const value = await new WorkerUpdater({ stateDirectory: f.root, version: '1.0.0', manifestSha256: 'c'.repeat(64),
    workerInstallationId: f.pairing.workerInstallationId, facts, assertStateOwnership: () => {},
    connection: () => ({ captureRequest: () => ({ request: async (payload: {
      operation: string; path: string; offset: number; manifestSha256: string;
    }) => {
      if (payload.operation === 'release') return { payload: { operation: 'release', release } }
      if (payload.operation === 'ci-smoke') {
        activity.push('ci-smoke')
        return { payload: { operation: 'ci-smoke', ciSmoke: null } }
      }
      throw new Error(`Unexpected Main request: ${payload.operation}`)
    } }) }),
    fetchAsset: async ({ destination }: { destination: string }) => {
      activity.push('download')
      const source = join(f.root, 'github-asset')
      await mkdir(join(source, 'src'), { recursive: true })
      await writeFile(join(source, 'src/cli.mjs'), bytes)
      await writeFile(join(source, 'manifest.json'), manifestBytes)
      execFileSync('tar', ['-czf', destination, '-C', source, '.'])
    },
    drain: () => f.mounted.drainForUpdate(), resume: () => f.mounted.resumeAfterUpdate(),
    locateLaunch: async () => ({ root: f.root }),
    stage: async () => { activity.push('stage'); return { directory: join(f.root, 'installed') } },
    launchSupervisor: async () => { activity.push('restart') },
  }).initialize()
  return { value, activity }
}

it.each(['ci-host-v1', 'ci-runtime-v1'])(
  'waits for acknowledged %s preparation before the installed updater stages or restarts', async namespace => {
  const f = await fixture()
  const operationId = randomUUID()
  const request = namespace === 'ci-host-v1'
    ? { operation: 'start', runId: operationId, repository: 'fixture/site', commit: 'a'.repeat(40), suite: 'lint', scope: 'full' }
    : { operation: 'prepare', operationId, repository: 'fixture/site', commit: 'a'.repeat(40), keepImages: [],
      review: { reviewedByPrincipalId: 'fixture-owner', decisionDigest: 'b'.repeat(64) } }
  const u = await updater(f)
  let updating: Promise<unknown> | undefined
  try {
    await f.handle(namespace, request)
    await vi.waitFor(() => expect(f.preparationEntered()).toBe(true))
    if (namespace === 'ci-runtime-v1') {
      const status = await f.handle(namespace, { operation: 'status' })
      expect(status.payload).toMatchObject({ operationId, commit: request.commit, state: 'preparing' })
    }
    updating = u.value.start()
    await vi.waitFor(async () => expect((await u.value.status()).state).toBe('draining'))
    await new Promise<void>(resolve => setImmediate(resolve))
    // The verified download precedes the drain; staging and restart wait for the preparation.
    expect(u.activity).toEqual(['download', 'ci-smoke'])
    const next = namespace === 'ci-host-v1'
      ? { ...request, runId: randomUUID() } : { ...request, operationId: randomUUID() }
    const denied = f.handle(namespace, next)
    await expect(denied)
      .rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    await denied.catch(error => {
      expect(deviceApplicationFailure(error)).toEqual({
        code: 'WORKER_RUNTIME_DRAINING', class: 'transient', retryable: true,
      })
    })
    f.release()
    await updating
    expect(u.activity).toEqual(['download', 'ci-smoke', 'stage', 'restart'])
    expect(await u.value.status()).toMatchObject({ state: 'restarting', targetVersion: '1.1.0', lastError: null })
    if (namespace === 'ci-host-v1') expect(preparation.launches).toBe(1)
    await f.mounted.close()
    const restarted = await createInstalledWorkerDomains(f.options)
    try {
      const extension = restarted.extensions.find(value => value.namespace === namespace)!
      const result = await extension.handle!({ operation: 'status' }, f.context)
      if (namespace === 'ci-host-v1') {
        expect(result.payload).toMatchObject({ runs: [{ runId: operationId, state: 'running' }] })
      } else {
        expect(result.payload).toMatchObject({ operationId, commit: request.commit, state: 'prepared' })
      }
    } finally { await restarted.close() }
  } finally {
    f.release()
    await updating
    await u.value.close()
    await f.mounted.close()
  }
})

it('allows an installed update after CI source fetching fails without entering runtime preparation', async () => {
  const f = await fixture()
  preparation.failSource = true
  const u = await updater(f)
  let updating: Promise<unknown> | undefined
  try {
    const operationId = randomUUID()
    const commit = 'a'.repeat(40)
    const started = await f.handle('ci-runtime-v1', {
      operation: 'prepare', operationId, repository: 'fixture/site', commit, keepImages: [],
      review: { reviewedByPrincipalId: 'fixture-owner', decisionDigest: 'b'.repeat(64) },
    })
    expect(started.payload).toMatchObject({ operationId, commit, state: 'preparing' })
    await vi.waitFor(async () => {
      const status = await f.handle('ci-runtime-v1', { operation: 'status' })
      expect(status.payload).toMatchObject({ operationId, commit, state: 'failed', prepared: null,
        message: 'GitHub git fetch failed. Check repository access and local Git configuration, then retry.' })
    })
    expect(f.preparationEntered()).toBe(false)
    updating = u.value.start()
    await updating
    expect(u.activity).toEqual(['download', 'ci-smoke', 'stage', 'restart'])
    expect(await u.value.status()).toMatchObject({ state: 'restarting', lastError: null })
  } finally {
    f.release()
    await updating
    await u.value.close()
    await f.mounted.close()
  }
})
