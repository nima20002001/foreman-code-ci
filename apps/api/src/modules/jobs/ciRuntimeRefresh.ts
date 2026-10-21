import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { InstalledVerificationRuntimeCaptureInputSchema, InstalledVerificationRuntimeConfigurationSchema,
  type InstalledVerificationRuntimeCaptureInput, type InstalledVerificationRuntimeConfiguration }
  from './installedVerificationConfiguration.js'
import type { JobResourceRequest, PreparedCiRuntime } from '@foreman-code/contracts'
import { DEVICE_MIB, DEVICE_RESOURCE_HOST_RESERVE, DeviceResourceLimitsSchema, type DeviceResourceLimits }
  from '@foreman-code/contracts/device-resources'
import { InstalledJobRuntimeConfigurationRecordSchema } from './installedRuntimeConfiguration.js'
import { readCiRuntimeInstallation, readCiRuntimeTemplate, relocateCiQuotaSlots } from './ciRuntimeInstallation.js'
import { DomainError } from '../errors.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'

const run = promisify(execFile)

/** What this computer can lend to builds: every CPU and its memory less the host reserve. The owner's build
 * allowance percent scales it, and each Job stays inside its own container limits. Disk keeps its installed quota. */
export function hostDeviceLimits(installed: DeviceResourceLimits,
  host = { cpus: availableParallelism(), memoryBytes: totalmem() }): DeviceResourceLimits {
  const reserve = Math.max(DEVICE_RESOURCE_HOST_RESERVE.minimumMemoryBytes,
    host.memoryBytes * DEVICE_RESOURCE_HOST_RESERVE.memoryFraction)
  const increment = 64 * DEVICE_MIB
  return DeviceResourceLimitsSchema.parse({ ...installed, cpuLimit: host.cpus,
    memoryBytes: Math.floor((host.memoryBytes - reserve) / increment) * increment,
    pidsLimit: Math.max(installed.pidsLimit, 8192) })
}

/** The next protected runtime: the current installation with the prepared image, seed, qualification source and root. */
export function nextCaptureInput(current: unknown, prepared: PreparedCiRuntime, input: {
  root: SourceRootRecord; manifest: SourceManifest; seedReceiptPath: string; resources: JobResourceRequest
  toolSources?: InstalledVerificationRuntimeCaptureInput['toolSources']
}): InstalledVerificationRuntimeCaptureInput {
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse(current)
  const { bootId: _boot, runtimeBinarySha256: _runtime, ociBinarySha256: _oci, configurationDigest: _configuration,
    seedReceiptSha256: _seed, tools: _tools, ...machine } = configuration.machine
  void _boot; void _runtime; void _oci; void _configuration; void _seed; void _tools
  return InstalledVerificationRuntimeCaptureInputSchema.parse({
    schemaVersion: 2, root: input.root, descriptor: { ...configuration.descriptor, resources: input.resources,
      target: { hostRef: input.root.selection.hostRef, registration: input.root.registration,
        mainInstallationId: input.root.binding.mainId } },
    machine: { ...machine, ...(machine.deviceLimits ? { deviceLimits: hostDeviceLimits(machine.deviceLimits) } : {}),
      resources: input.resources, limits: input.resources.limits,
      imageDigest: prepared.imageId, imageConfigDigest: prepared.imageId,
      imageManifestDigest: prepared.imageManifestDigest, sourceCommit: prepared.commit },
    seedReceiptPath: input.seedReceiptPath,
    qualificationSource: { directory: prepared.qualificationSource, manifest: input.manifest },
    toolSources: input.toolSources ?? [
      ...configuration.machine.tools.filter(tool => tool.kind !== 'codex').map(tool => ({
        kind: tool.kind, executable: tool.executable, sourceExecutable: tool.executable, version: tool.version,
      })),
      ...preparedCodexSource(prepared),
    ],
  })
}

/** Writes the reviewed refresh input and restarts this service around its refresh command, which needs the
 * service stopped. Runs as a separate user unit so it survives the service's own stop. A Worker runs its
 * `refresh-job-runtime`; Main passes its own `cli` and a private `workDirectory`. */
export async function scheduleCiRuntimeRefresh(input: {
  operationId: string
  stateDirectory: string; prepared: PreparedCiRuntime; root: SourceRootRecord; manifest: SourceManifest
  resources: JobResourceRequest; environment?: NodeJS.ProcessEnv
  /** Where refresh inputs, logs and the last outcome live; defaults to the Worker installation directory. */
  workDirectory?: string
  /** The refresh command, before its `--state` and `--input` arguments. */
  cli?: readonly string[]
  drain(): Promise<void>
}): Promise<{ unit: string; workerUnit: string }> {
  await input.drain()
  const environment = input.environment ?? process.env
  const configurationPath = join(input.stateDirectory, 'job-runtime.json')
  let currentBytes: Buffer | null
  try { currentBytes = await readFile(configurationPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    currentBytes = null
  }
  const base = input.workDirectory ?? join(input.stateDirectory, 'managed', 'ci')
  await mkdir(base, { recursive: true, mode: 0o700 })
  await pruneCiRuntimeRefreshFiles(input.stateDirectory, base)
  const short = input.operationId
  const seedReceiptPath = join(base, `installed-seed-receipt-${short}.json`)
  const original = await readCiRuntimeTemplate(input.stateDirectory)
  if (!original) throw new DomainError('CI_RUNTIME_INSTALLATION_MISSING', 'No installed CI runtime is available.', 409)
  const quotaPool = await relocateCiQuotaSlots(original, input.root)
  if (quotaPool === null) {
    throw new DomainError('CI_RUNTIME_RELOCATION_REQUIRED',
      'Legacy CI quota storage cannot move across filesystems. Reinstall it before refreshing; Host CI needs no refresh.',
      409)
  }
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse({ ...original,
    descriptor: { ...original.descriptor, quotaPool }, machine: { ...original.machine, quotaPool } })
  const toolSources = await recaptureCiTools(configuration.machine.tools, input.prepared, base, environment)
  const captureInput = nextCaptureInput(configuration, input.prepared,
    { root: input.root, manifest: input.manifest, seedReceiptPath, resources: input.resources, toolSources })
  const refreshPath = join(base, `reviewed-refresh-${short}.json`)
  const refreshInput = currentBytes
    ? { expectedConfigurationSha256: createHash('sha256').update(currentBytes).digest('hex'), captureInput }
    : captureInput
  const workerUnit = await currentServiceUnit()
  const unit = `foreman-ci-refresh-${short}`
  const log = join(base, `refresh-${short}.log`)
  const cli = input.cli ?? [process.execPath, process.argv[1]!, currentBytes ? 'refresh-job-runtime' : 'capture-job-runtime']
  const script = 'unit=$1; log=$2; shift 2; systemctl --user stop "$unit"; "$@" > "$log" 2>&1;'
    + ' echo "exit=$?" >> "$log"; systemctl --user start "$unit"'
  try {
    await copyFile(input.prepared.seedReceiptPath, seedReceiptPath)
    await chmod(seedReceiptPath, 0o600)
    await writeFile(refreshPath, JSON.stringify(refreshInput), { mode: 0o600 })
    await writeFile(join(base, LAST_REFRESH), JSON.stringify({ operationId: input.operationId,
      commit: input.prepared.commit, log }), { mode: 0o600 })
    await pruneCiRuntimeRefreshFiles(input.stateDirectory, base, [seedReceiptPath, refreshPath])
    await run('systemd-run', ['--user', '--collect', `--unit=${unit}`, `--setenv=PATH=${environment.PATH ?? '/usr/bin:/bin'}`,
      `--working-directory=${process.cwd()}`, '/bin/sh', '-c', script, 'refresh', workerUnit, log,
      ...cli, '--state', input.stateDirectory, '--input', refreshPath], { env: environment })
  } catch (error) {
    await pruneCiRuntimeRefreshFiles(input.stateDirectory, base)
    throw error
  }
  return { unit, workerUnit }
}

const LAST_REFRESH = 'ci-runtime-last-refresh.json'

/** Keeps refresh files used by retained configurations, the last log, and the pending refresh. */
export async function pruneCiRuntimeRefreshFiles(stateDirectory: string, workDirectory = join(stateDirectory, 'managed', 'ci'),
  pendingPaths: readonly string[] = []): Promise<void> {
  const kept = new Set(pendingPaths)
  for (const name of await readdir(stateDirectory)) {
    if (!/^job-runtime(?:-[a-f0-9]{64})?\.json$/u.test(name)) continue
    const configuration = JSON.parse(await readFile(join(stateDirectory, name), 'utf8')) as { seedReceiptPath?: string }
    if (configuration.seedReceiptPath) kept.add(configuration.seedReceiptPath)
  }
  const recorded = await readFile(join(workDirectory, LAST_REFRESH), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (recorded) {
    const last = JSON.parse(recorded) as { log: string }
    kept.add(last.log)
  }
  for (const entry of await readdir(workDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:installed-seed-receipt-.+\.json|reviewed-refresh-.+\.json|refresh-.+\.log)$/u.test(entry.name)) {
      continue
    }
    const path = join(workDirectory, entry.name)
    if (!kept.has(path)) await rm(path)
  }
}
/** The outcome of the last refresh, read by the restarted Worker: null while none ran. */
export async function lastCiRuntimeRefresh(stateDirectory: string, workDirectory = join(stateDirectory, 'managed', 'ci')): Promise<{
  operationId: string | null; commit: string; ok: boolean; log: string
} | null> {
  const recorded = await readFile(join(workDirectory, LAST_REFRESH), 'utf8')
    .catch(fallbackOnError(null, 'jobs', 'read last CI runtime refresh', {}, ['ENOENT']))
  if (!recorded) return null
  const { operationId, commit, log } = JSON.parse(recorded) as { operationId?: string; commit: string; log: string }
  const text = await readFile(log, 'utf8').catch(() => '')
  return { operationId: operationId ?? null, commit, ok: /^exit=0$/mu.test(text), log: text.slice(-1500) }
}

/** The Worker's own systemd user unit: the innermost `.service` in its cgroup path. */
async function currentServiceUnit(): Promise<string> {
  const cgroup = await readFile('/proc/self/cgroup', 'utf8')
  const unit = cgroup.split('\n').flatMap(line => line.split(':').at(-1)?.split('/') ?? [])
    .filter(part => part.endsWith('.service') && !part.startsWith('user@')).at(-1)
  if (!unit) throw new Error('This Worker is not running as a systemd user service, so it cannot restart itself.')
  return unit
}

/** The installer paths the current protected runtime uses; preparation keeps them. */
export async function currentCiRuntimePaths(stateDirectory: string): Promise<string[]> {
  const configuration = await readCiRuntimeTemplate(stateDirectory)
  if (!configuration) return []
  return [configuration.qualificationSource?.directory, configuration.seedReceiptPath]
    .filter((path): path is string => typeof path === 'string')
}

/** Protected previous configurations remain recovery inputs after a refresh while something still uses their
 * image: a current verification profile (`keepImages` from Main), an accepted Job or a pending qualification.
 * Others are retired so their image and qualification source can be reclaimed; the current one always stays. */
export async function retireCiRuntimeConfigurations(stateDirectory: string, keepImages: readonly string[]) {
  const kept = new Set(keepImages)
  const retained = { images: [] as string[], paths: [] as string[] }
  const installation = await readCiRuntimeInstallation(stateDirectory)
  if (installation) {
    retained.images.push(installation.runtime.machine.imageDigest)
    retained.paths.push(installation.runtime.qualificationSource.directory, installation.runtime.seedReceiptPath)
  }
  for (const name of (await readdir(stateDirectory)).sort()) {
    if (!/^job-runtime(?:-[a-f0-9]{64})?\.json$/u.test(name)) continue
    const raw = JSON.parse(await readFile(join(stateDirectory, name), 'utf8')) as { qualificationSource?: { directory?: unknown } }
    const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(raw)
    const image = configuration.schemaVersion === 2 ? configuration.machine.imageDigest : configuration.pins.imageDigest
    if (name !== 'job-runtime.json' && !kept.has(image)) {
      await rm(join(stateDirectory, name))
      continue
    }
    retained.images.push(image)
    if (typeof raw.qualificationSource?.directory === 'string') retained.paths.push(raw.qualificationSource.directory)
    if (configuration.schemaVersion === 2) retained.paths.push(configuration.seedReceiptPath)
  }
  return retained
}

export async function recaptureCiTools(
  tools: InstalledVerificationRuntimeConfiguration['machine']['tools'],
  prepared: PreparedCiRuntime, directory: string, environment: NodeJS.ProcessEnv,
): Promise<InstalledVerificationRuntimeCaptureInput['toolSources']> {
  const sources = preparedCodexSource(prepared)
  const imageTools = tools.filter(tool => tool.kind !== 'codex').map(({ kind, executable }) => ({ kind, executable }))
  if (!imageTools.some(tool => tool.kind === 'postgresql')) {
    imageTools.push({ kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres' })
  }
  const container = (await run('podman', ['--remote=false', 'create', prepared.imageId, 'true'],
    { env: environment })).stdout.trim()
  try {
    for (const tool of imageTools) {
      const sourceExecutable = join(directory, `ci-tool-${tool.kind}-${prepared.commit.slice(0, 12)}`)
      await run('podman', ['--remote=false', 'cp', `${container}:${tool.executable}`, sourceExecutable], { env: environment })
      await chmod(sourceExecutable, 0o700)
      const result = await run('podman', ['--remote=false', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
        '--cap-drop=all', '--security-opt=no-new-privileges', '--cpus=1', '--memory=512m', '--pids-limit=64',
        `--entrypoint=${tool.executable}`, prepared.imageId, '--version'], { env: environment })
      let version = result.stdout.trim()
      if (tool.kind === 'postgresql') version = /PostgreSQL\)\s+(\S+)/u.exec(version)?.[1] ?? version
      sources.push({ kind: tool.kind, executable: tool.executable, sourceExecutable, version })
    }
  } finally {
    await run('podman', ['--remote=false', 'rm', container], { env: environment })
  }
  return sources
}

function preparedCodexSource(prepared: PreparedCiRuntime): InstalledVerificationRuntimeCaptureInput['toolSources'] {
  if (!prepared.unitCodex) return []
  return [{ kind: 'codex', executable: prepared.unitCodex.executable,
    sourceExecutable: prepared.unitCodex.sourceExecutable, version: prepared.unitCodex.version }]
}
