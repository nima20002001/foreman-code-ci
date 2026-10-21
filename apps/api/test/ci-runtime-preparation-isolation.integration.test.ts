import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CI_RUNTIME_NAMESPACE, CiRuntimeWorkerStateSchema } from '@foreman-code/contracts'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { createInstalledWorkerDomains } from '../src/modules/devices/installedWorkerDomains.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { bootIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './helpers/privateFixtureDirectory.js'

const ports = vi.hoisted(() => ({ repository: '', imageBuilds: 0 }))
const buildBoundary = 'Fixture stopped at the OCI image build boundary.'

// Git and installed preparation run normally; no OCI execution or physical qualification is claimed.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const run = promisify(actual.execFile)
  const execFile = Object.assign(actual.execFile.bind(null), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (
      file: string, args: string[], options: Parameters<typeof run>[2],
    ) => {
      if (file !== 'podman') return run(file, args, options)
      // No image or interrupted Buildah working container exists in this fixture store.
      if (args.includes('images') || args.includes('ps')) return { stdout: '[]', stderr: '' }
      if (args.includes('build')) {
        ports.imageBuilds++
        throw new Error('Fixture stopped at the OCI image build boundary.')
      }
      throw new Error(`Unexpected OCI operation: ${args.join(' ')}`)
    },
  })
  return { ...actual, execFile }
})

vi.mock('../src/modules/sources/gitWorktree.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/modules/sources/gitWorktree.js')>()
  return { ...actual, systemGitWorktreePorts: (environment: NodeJS.ProcessEnv) => ({
    ...actual.systemGitWorktreePorts(environment),
    cloneDirectory: () => ports.repository,
  }) }
})

async function repository(directory: string, marker: string) {
  const source = join(directory, 'repository')
  await mkdir(source)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '-q')
  await mkdir(join(source, 'scripts'))
  await writeFile(join(source, 'scripts/build-ci-runtime-context.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped'); `
      + `throw Error('Repository preparation executed on the host');`)
  await writeFile(join(source, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.27.0' }))
  await writeFile(join(source, 'pnpm-lock.yaml'), 'packages: {}\n')
  await writeFile(join(source, 'pnpm-workspace.yaml'),
    'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n')
  const controls = join(source, 'apps/worker/artifacts/ci-runtime')
  await mkdir(controls, { recursive: true })
  for (const name of ['Containerfile', 'corepack']) await writeFile(join(controls, name), 'fixture')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
  return { source, commit: git('rev-parse', 'HEAD') }
}

describe('installed Worker preparation host boundary', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('denies a stale channel and does not execute committed preparation code outside the approved root', async () => {
    await withPrivateFixtureDirectories(async () => {
      const directory = await privateFixtureDirectory('worker-preparation-isolation-')
      const marker = join(directory, 'outside-approved-root')
      const fixture = await repository(directory, marker)
      ports.repository = fixture.source
      ports.imageBuilds = 0
      const stateDirectory = join(directory, 'state')
      const runtimeRoot = join(directory, 'approved-runtime')
      await mkdir(stateDirectory)
      await mkdir(join(runtimeRoot, 'installer'), { recursive: true })
      for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
        const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { initializeNewInstallation: true })
        await journal.close()
      }
      const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1,
        mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
        keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://fixture.example/device/connect',
        mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString() })
      const runtimeStat = await stat(runtimeRoot)
      const filesystem = { device: String(runtimeStat.dev), inode: String(runtimeStat.ino), mountId: '1' }
      const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1,
        hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
        applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: runtimeRoot, filesystem, accessModes: ['read-write'] }],
        managedRuntimeRoot: runtimeRoot, runtimeFilesystem: filesystem })
      const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
        workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
        bootId: bootIdentity(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
      vi.stubEnv('GIT_DIR', join(directory, 'outer-job.git'))
      vi.stubEnv('GIT_WORK_TREE', join(directory, 'outer-job-source'))
      const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
        configuration: null, jobConfiguration: { path: join(stateDirectory, 'job-runtime.json'), ownerUid: process.getuid!() },
        approvedRoots: async () => approved,
        connection: () => ({ currentBinding: () => binding, captureRequest: () => undefined, mainNow: Date.now }),
        codexSuiteRevision: 'fixture' })
      try {
        const handler = mounted.extensions.find(extension => extension.namespace === CI_RUNTIME_NAMESPACE)!
        const context = { binding, signal: AbortSignal.timeout(15_000) }
        const request = { operation: 'prepare', operationId: randomUUID(), repository: 'fixture/site', commit: fixture.commit,
          keepImages: [], review: { reviewedByPrincipalId: 'owner', decisionDigest: 'c'.repeat(64) } }
        await expect(handler.handle!(request, { ...context,
          binding: { ...binding, connectionEpoch: randomUUID() } })).rejects.toThrow('authenticated worker channel')
        expect(CiRuntimeWorkerStateSchema.parse((await handler.handle!({ operation: 'status' }, context)).payload).state)
          .toBe('idle')
        expect(CiRuntimeWorkerStateSchema.parse((await handler.handle!(request, context)).payload).state)
          .toBe('preparing')
        await expect.poll(async () => CiRuntimeWorkerStateSchema.parse(
          (await handler.handle!({ operation: 'status' }, context)).payload).state, { timeout: 10_000 }).toBe('failed')
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        const result = CiRuntimeWorkerStateSchema.parse((await handler.handle!({ operation: 'status' }, context)).payload)
        expect(result).toMatchObject({ commit: fixture.commit, stage: 'fetch-packages', message: buildBoundary })
        expect(ports.imageBuilds).toBe(1)
        const capturedManifest = join(runtimeRoot, 'installer', `build-context-${fixture.commit.slice(0, 12)}`,
          'source-lock/package.json')
        expect(JSON.parse(await readFile(capturedManifest, 'utf8'))).toEqual({ packageManager: 'pnpm@11.27.0' })
      } finally {
        await mounted.close()
      }
    })
  })
})
