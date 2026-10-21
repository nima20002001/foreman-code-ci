import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CiRuntimeWorker } from '../src/modules/jobs/ciRuntimeWorker.js'
import { runCiRuntimeCommand } from '../src/modules/jobs/ciRuntimeCommands.js'
import { reclaimInterruptedPreparation } from '../src/modules/jobs/ciRuntimePrepare.js'
import { identityAlive, processIdentity, type LinuxProcessIdentity }
  from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from '../src/modules/jobs/installedVerificationConfiguration.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { physicalFaultEnvironment } from './helpers/physicalFaultEnvironment.js'

const require = createRequire(import.meta.url)
const service = fileURLToPath(new URL('./fixtures/ciPreparationService.ts', import.meta.url))
const stages = ['build', 'seed-copy'] as const
const faults = ['graceful-stop', 'forced-exit'] as const

async function serviceProcesses(controlGroup: string, marker: string): Promise<LinuxProcessIdentity[]> {
  const found = new Map<number, LinuxProcessIdentity>()
  const visit = async (path: string): Promise<void> => {
    const pids = (await readFile(join(path, 'cgroup.procs'), 'utf8')).trim().split(/\s+/).filter(Boolean)
    for (const text of pids) {
      const identity = processIdentity(Number(text))
      if (identity) found.set(identity.pid, identity)
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name))
    }
  }
  await visit(join('/sys/fs/cgroup', controlGroup))
  // Rootless Buildah can put RUN in a sibling systemd scope; include the unique workload marker there.
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    let argv: string
    try { argv = await readFile(`/proc/${entry}/cmdline`, 'utf8') }
    catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    if (!argv.includes(marker)) continue
    const identity = processIdentity(Number(entry))
    if (identity) found.set(identity.pid, identity)
  }
  return [...found.values()]
}

describe('preparation across disposable service replacement', () => {
  for (const stage of stages) {
    it.each(faults)(`closes original ${stage} processes before replacement after %s`, async fault => {
      const path = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
      if (!path) throw new Error('Provide FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION.')
      const installed = await readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
        InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
      const directory = await privateFixtureDirectory('ci-service-fault-')
      const installer = join(directory, 'installer')
      const unit = `foreman-preparation-fault-${randomUUID()}.service`
      const seedIdentity = `foreman-ci-seed-${randomUUID()}`
      const foreignSeed = `foreman-ci-seed-${randomUUID()}`
      const hostEnvironment = physicalFaultEnvironment()
      const command = (file: string, argv: string[], env: NodeJS.ProcessEnv = hostEnvironment) =>
        runCiRuntimeCommand(file, argv, { env, signal: AbortSignal.timeout(180_000) })
      const systemctl = (argv: string[]) => command('systemctl', ['--user', ...argv])
      const stopUnit = () => systemctl(['stop', unit]).catch((error: { code?: unknown }) => {
        if (error.code !== 5) throw error
      })
      const storagePath = join(directory, 'storage.conf')
      const environment = { ...hostEnvironment, CONTAINERS_STORAGE_CONF: storagePath,
        TMPDIR: join(directory, 'tmp') }
      const podman = (argv: string[]) => command(installed.machine.runtimeExecutable,
        ['--remote=false', ...argv], environment)
      const original: LinuxProcessIdentity[] = []
      let started = false
      let storageReady = false
      let replacement: CiRuntimeWorker | undefined
      const replacementLifetime = new AbortController()
      try {
        await mkdir(installer, { mode: 0o700 })
        await mkdir(environment.TMPDIR, { mode: 0o700 })
        await mkdir(join(directory, 'build-context'), { mode: 0o700 })
        await mkdir(join(directory, 'fault-output'), { mode: 0o700 })
        await writeFile(storagePath, '[storage]\ndriver = "vfs"\n'
          + `graphroot = ${JSON.stringify(join(directory, 'storage'))}\n`
          + `runroot = ${JSON.stringify(join(directory, 'runroot'))}\n`, { mode: 0o600 })
        storageReady = true
        const archive = join(directory, 'image.tar')
        await command(installed.machine.runtimeExecutable,
          ['--remote=false', 'save', '--output', archive, installed.machine.imageDigest])
        await podman(['load', '--input', archive])
        await rm(archive)
        const image = JSON.parse((await podman(['image', 'inspect', installed.machine.imageDigest])).stdout)[0].Id as string
        await podman(['create', '--name', foreignSeed, '--label', 'io.foreman-code.installation=another-installer',
          '--label', 'io.foreman-code.ci-preparation=seed', image, 'true'])
        const marker = `preparation-fault-${randomUUID()}`
        const script = `require('node:fs').writeFileSync('/faults/build-started', '${marker}');`
          + `process.on('SIGTERM',()=>{});setInterval(()=>{},1000); // ${marker}`
        await writeFile(join(directory, 'build-context', 'Containerfile'),
          `FROM ${image}\nRUN ["node", "-e", ${JSON.stringify(script)}]\n`, { mode: 0o600 })
        const request = { operation: 'prepare' as const, operationId: randomUUID(), repository: 'fixture/site',
          commit: 'a'.repeat(40), keepImages: [],
          review: { reviewedByPrincipalId: 'fixture-owner', decisionDigest: 'b'.repeat(64) } }
        const inputPath = join(directory, 'service-input.json')
        await writeFile(inputPath, JSON.stringify({ directory, installer, environment, stage,
          podman: installed.machine.runtimeExecutable, image, seedIdentity, request }), { mode: 0o600 })
        started = true
        await command('systemd-run', ['--user', '--quiet', `--unit=${unit}`,
          '--property=KillMode=control-group', '--property=Delegate=cpu memory pids',
          '--property=TimeoutStopSec=15', '--property=NoNewPrivileges=yes', '--property=UMask=0077',
          `--working-directory=${directory}`, process.execPath, '--import', require.resolve('tsx'), service, inputPath])
        const barrier = stage === 'build' ? join(directory, 'fault-output', 'build-started')
          : join(directory, 'seed-copy-started')
        await vi.waitFor(async () => expect((await readFile(barrier, 'utf8')).length).toBeGreaterThan(0),
          { timeout: 30_000, interval: 50 })
        const group = (await systemctl(['show', '--property=ControlGroup', '--value', unit])).stdout.trim()
        expect(group).toMatch(/^\/.*foreman-preparation-fault-/)
        original.push(...await serviceProcesses(group, marker))
        expect(original.length).toBeGreaterThan(1)
        if (stage === 'build') {
          expect(JSON.parse((await podman(['ps', '--all', '--external', '--format', 'json'])).stdout)
            .some((container: { State?: string; Command?: string[] }) =>
              container.State === 'storage' && container.Command?.[0] === 'buildah')).toBe(true)
        } else {
          expect((await podman(['container', 'exists', seedIdentity])).stdout).toBe('')
        }
        if (fault === 'graceful-stop') await stopUnit()
        else await systemctl(['kill', '--kill-whom=all', '--signal=SIGKILL', unit])
        await vi.waitFor(async () => {
          const state = (await systemctl(['show', '--property=ActiveState', '--value', unit])).stdout.trim()
          expect(['inactive', 'failed']).toContain(state)
        }, { timeout: 20_000, interval: 100 })
        expect(original.filter(identityAlive)).toEqual([])
        if (fault === 'graceful-stop') {
          expect(JSON.parse(await readFile(join(directory, 'shutdown-state.json'), 'utf8')))
            .toMatchObject({ state: 'failed', prepared: null, message: 'Preparation service stopped' })
        }
        const prepared = { commit: request.commit, imageId: image, imageManifestDigest: image,
          qualificationSource: join(installer, 'qualification-source'),
          seedReceiptPath: join(installer, 'seed.json'), contextReceiptPath: join(installer, 'context.json') }
        await command('git', ['init', join(directory, 'repository')])
        const prepare = vi.fn(async () => {
          expect(original.filter(identityAlive)).toEqual([])
          await reclaimInterruptedPreparation({ repository: join(directory, 'repository'), installer,
            keepPaths: [], env: environment, signal: replacementLifetime.signal })
          const containers = JSON.parse((await podman(['ps', '--all', '--external', '--format', 'json'])).stdout)
          expect(containers.some((container: { State?: string; Command?: string[] }) =>
            container.State === 'storage' && container.Command?.[0] === 'buildah')).toBe(false)
          expect(containers.some((container: { Labels?: Record<string, string> }) =>
            container.Labels?.['io.foreman-code.installation']
              === createHash('sha256').update(installer).digest('hex'))).toBe(false)
          expect((await podman(['container', 'exists', foreignSeed])).stdout).toBe('')
          expect((await podman(['run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--cap-drop=all', '--security-opt=no-new-privileges', '--entrypoint=node', image,
            '-e', 'process.stdout.write("replacement")'])).stdout).toBe('replacement')
          return prepared
        })
        replacement = new CiRuntimeWorker(directory, {
          git: { cloneDirectory: () => directory, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
          managedRuntimeRoot: async () => directory, currentRuntimePaths: async () => [],
          prepare, lastRefresh: async () => null, now: () => new Date(),
          refresh: async () => { throw new Error('Replacement does not refresh installed runtimes.') },
        }, replacementLifetime.signal)
        const replacementRequest = { ...request, operationId: randomUUID() }
        expect((await replacement.handle(replacementRequest)).state).toBe('preparing')
        await replacement.close()
        expect(await replacement.handle({ operation: 'status' })).toMatchObject({
          operationId: replacementRequest.operationId, state: 'prepared', prepared,
        })
        expect(prepare).toHaveBeenCalledOnce()
      } finally {
        replacementLifetime.abort()
        await replacement?.close()
        if (started) await stopUnit()
        for (const identity of original) {
          if (identityAlive(identity)) process.kill(identity.pid, 'SIGKILL')
        }
        await vi.waitFor(() => expect(original.filter(identityAlive)).toEqual([]), { timeout: 5000 })
        if (storageReady) {
          await podman(['rm', '--all', '--force'])
          const external = JSON.parse((await podman(['ps', '--all', '--external', '--format', 'json'])).stdout)
          for (const container of external as { Id: string }[]) await podman(['rm', '--force', container.Id])
        }
        await rm(directory, { recursive: true, force: true })
      }
    }, 600_000)
  }
})
