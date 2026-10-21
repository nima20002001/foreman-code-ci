import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreparedCiRuntime } from '@foreman-code/contracts'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationConfiguration.js'
import { currentCiRuntimePaths, hostDeviceLimits, nextCaptureInput, recaptureCiTools, retireCiRuntimeConfigurations,
  pruneCiRuntimeRefreshFiles, scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'
import { refreshMainJobRuntime } from '../../cli/refreshMainJobRuntime.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'
import * as privateFilesystem from '../sources/privateFilesystem.js'
import { relocateCiQuotaSlots } from './ciRuntimeInstallation.js'

const commands = vi.hoisted(() => ({ run: vi.fn(), beforeRename: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[]) => ({
      stdout: await commands.run(file, args), stderr: '',
    }),
  })
  return { ...actual, execFile }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await commands.beforeRename(...args)
    return actual.rename(...args)
  }, readFile: (path: string, ...options: unknown[]) => path === '/proc/self/cgroup'
    ? Promise.resolve('0::/user.slice/worker.service\n')
    : actual.readFile(path, ...(options as [])) }
})

const capture = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock('./installedRuntimeHost.js', async importOriginal => ({
  ...await importOriginal<typeof import('./installedRuntimeHost.js')>(),
  captureInstalledRuntimeConfigurationRecord: capture.record,
}))

const roots: string[] = []
afterEach(async () => {
  commands.run.mockReset()
  commands.beforeRename.mockReset()
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

function fixture() {
  const f = verificationRuntimeFixture()
  const fingerprint = f.measurement.fingerprint
  const omitted = new Set(['schemaVersion', 'profileId', 'profileRevision', 'specDigest', 'root', 'hostRef',
    'registration', 'mainInstallationId'])
  const machine = Object.fromEntries(Object.entries(fingerprint).filter(([key]) => !omitted.has(key)))
  const manifest = { version: 1, ...fingerprint.root.source, git: { commit: fingerprint.sourceCommit,
    tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved',
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const tools = [
    { kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres', version: '17.1', binarySha256: '1'.repeat(64) },
    { kind: 'browser', executable: '/usr/bin/chromium', version: 'Chromium 1', binarySha256: '2'.repeat(64) },
    { kind: 'claude', executable: '/usr/bin/claude', version: '1.0', binarySha256: '3'.repeat(64) },
    ...fingerprint.tools,
  ]
  const runtimeRoot = '/ci/runtime'
  const root = { ...fingerprint.root, binding: { ...fingerprint.root.binding,
    canonicalPath: join(runtimeRoot, 'source-materializations', fingerprint.root.selection.rootPolicyId) } }
  const current = InstalledVerificationRuntimeConfigurationSchema.parse({ schemaVersion: 2, root,
    machine: { ...machine, tools }, seedReceiptPath: '/ci/seed-receipt.json',
    seedReceiptSha256: fingerprint.seedReceiptSha256, qualificationSource: { directory: '/ci/source', manifest },
    descriptor: { target: { hostRef: fingerprint.hostRef, registration: fingerprint.registration,
      mainInstallationId: fingerprint.mainInstallationId }, runtimeExecutable: fingerprint.runtimeExecutable,
      ociExecutable: fingerprint.ociExecutable, findmntExecutable: '/usr/bin/findmnt', findmntBinarySha256: 'f'.repeat(64),
      runtimeRoot, backingFile: null, volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes,
      controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
      quota: fingerprint.quota, quotaPool: fingerprint.quotaPool, resources: fingerprint.resources,
      network: fingerprint.network, approvalConfig: fingerprint.approvalConfig,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest } })
  const prepared: PreparedCiRuntime = { commit: fingerprint.sourceCommit!, imageId: `sha256:${'9'.repeat(64)}`,
    imageManifestDigest: `sha256:${'8'.repeat(64)}`, seedReceiptPath: '/ci/prepared-seed.json',
    contextReceiptPath: '/ci/context.json', qualificationSource: '/ci/prepared-source',
    unitCodex: { executable: '/opt/graphql-ci/tools/codex', sourceExecutable: '/ci/prepared-codex',
      version: 'new-codex', binarySha256: '7'.repeat(64) } }
  return { current, prepared }
}

async function quotaRelocationFixture() {
  const f = fixture()
  const directory = await privateFixtureDirectory('ci-quota-adoption-')
  roots.push(directory)
  const runtimeRoot = join(directory, 'runtime')
  const oldPolicyId = randomUUID()
  const newPolicyId = randomUUID()
  const oldSource = join(runtimeRoot, 'source-materializations', oldPolicyId)
  const newSource = join(runtimeRoot, 'source-materializations', newPolicyId)
  for (const path of [oldSource, newSource]) await mkdir(path, { recursive: true, mode: 0o700 })
  const filesystem = async (path: string) => {
    const handle = await openPrivateRoot(path)
    try { return await identity(handle) } finally { await handle.close() }
  }
  const pool = f.current.descriptor.quotaPool!
  const slots = []
  for (const slot of pool.slots) {
    const path = join(oldSource, slot.namespace)
    await mkdir(path, { mode: 0o700 })
    await writeFile(join(path, 'retained'), slot.namespace)
    slots.push({ ...slot, filesystem: await filesystem(path) })
  }
  const quotaPool = { ...pool, slots }
  const current = { ...f.current,
    root: { ...f.current.root, selection: { ...f.current.root.selection, rootPolicyId: oldPolicyId },
      binding: { ...f.current.root.binding, canonicalPath: oldSource, filesystem: await filesystem(oldSource) } },
    descriptor: { ...f.current.descriptor, runtimeRoot, quotaPool },
    machine: { ...f.current.machine, quotaPool } }
  const root = { ...current.root, selection: { ...current.root.selection, rootPolicyId: newPolicyId },
    binding: { ...current.root.binding, canonicalPath: newSource, filesystem: await filesystem(newSource) } }
  return { current, root, slots, oldSource, newSource, directory }
}

describe('CI runtime refresh', () => {
  it('records what the computer can really lend instead of the installer\'s first limits', () => {
    const installed = { cpuLimit: 4.25, memoryBytes: 4608 * 2 ** 20, diskBytes: 16 * 2 ** 30, pidsLimit: 1088 }
    const gib = 2 ** 30
    expect(hostDeviceLimits(installed, { cpus: 16, memoryBytes: 14.5 * gib }))
      .toEqual({ cpuLimit: 16, memoryBytes: 13 * gib, diskBytes: 16 * gib, pidsLimit: 8192 })
    // Small hosts keep at least 1 GiB for themselves.
    expect(hostDeviceLimits(installed, { cpus: 2, memoryBytes: 4 * gib }).memoryBytes).toBe(3 * gib)
  })
  it.each(['worker', 'main'])('reclaims stale refresh files while preserving retained inputs and the last log on %s', async host => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-refresh-cleanup-')
    roots.push(directory)
    const state = join(directory, 'state')
    const work = host === 'worker' ? directory : join(directory, 'ci-runtime-refresh')
    await mkdir(state)
    await mkdir(work, { recursive: true })
    const current = join(work, 'installed-seed-receipt-current.json')
    const retained = join(work, 'installed-seed-receipt-retained.json')
    const stale = join(work, 'installed-seed-receipt-stale.json')
    const lastLog = join(work, 'refresh-last.log')
    const pending = [join(work, 'installed-seed-receipt-pending.json'), join(work, 'reviewed-refresh-pending.json')]
    for (const path of [current, retained, stale, lastLog, ...pending,
      join(work, 'refresh-stale.log'), join(work, 'reviewed-refresh-stale.json'), join(work, 'unrelated.json')]) {
      await writeFile(path, 'preserved bytes')
    }
    await writeFile(join(state, 'job-runtime.json'), JSON.stringify({ ...f.current, seedReceiptPath: current }))
    await writeFile(join(state, `job-runtime-${'a'.repeat(64)}.json`), JSON.stringify({ ...f.current,
      machine: { ...f.current.machine, imageDigest: `sha256:${'b'.repeat(64)}` }, seedReceiptPath: retained }))
    await writeFile(join(state, `job-runtime-${'c'.repeat(64)}.json`), JSON.stringify({ ...f.current,
      machine: { ...f.current.machine, imageDigest: `sha256:${'d'.repeat(64)}` }, seedReceiptPath: stale }))
    await writeFile(join(work, 'ci-runtime-last-refresh.json'), JSON.stringify({ log: lastLog }))
    await retireCiRuntimeConfigurations(state, [`sha256:${'b'.repeat(64)}`])
    await pruneCiRuntimeRefreshFiles(state, work, pending)
    for (const path of [current, retained, lastLog, ...pending, join(work, 'unrelated.json')]) {
      expect(await readFile(path, 'utf8')).toBe('preserved bytes')
    }
    for (const path of [stale, join(work, 'refresh-stale.log'), join(work, 'reviewed-refresh-stale.json')]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await pruneCiRuntimeRefreshFiles(state, work)
    for (const path of pending) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an unchanged source binding outside managed source storage', async () => {
    const f = fixture()
    const root = { ...f.current.root,
      binding: { ...f.current.root.binding, canonicalPath: '/approved/source' } }
    const current = { ...f.current, root }
    await expect(relocateCiQuotaSlots(current, root)).rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
  })

  it('moves adopted quota directories to the new source binding and resumes an interrupted move', async () => {
    const { current, root, slots, oldSource, newSource, directory } = await quotaRelocationFixture()
    const moved = await relocateCiQuotaSlots(current, root)
    expect(moved?.slots).toEqual(slots)
    for (const slot of slots) {
      expect(await readFile(join(newSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
      await expect(stat(join(oldSource, slot.namespace))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await relocateCiQuotaSlots(current, root)).toEqual(moved)
    await expect(relocateCiQuotaSlots(current, { ...root,
      binding: { ...root.binding, canonicalPath: directory } })).rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
  })
  it.each(['device', 'mountId'] as const)('skips a move to another %s before touching quota directories', async field => {
    const { current, root, slots, oldSource, newSource } = await quotaRelocationFixture()
    const destination = root.binding.filesystem
    const changed = { ...destination, [field]: String(BigInt(destination[field]) + 1n) }
    const observedIdentity = privateFilesystem.identity
    const readIdentity = vi.spyOn(privateFilesystem, 'identity').mockImplementation(async handle => {
      const observed = await observedIdentity(handle)
      return observed.inode === destination.inode ? changed : observed
    })
    try {
      expect(await relocateCiQuotaSlots(current, { ...root, binding: { ...root.binding, filesystem: changed } }))
        .toBeNull()
      expect(commands.beforeRename).not.toHaveBeenCalled()
      for (const slot of slots) {
        expect(await readFile(join(oldSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
        await expect(stat(join(newSource, slot.namespace))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      readIdentity.mockRestore()
    }
  })

  it('skips an EXDEV move without losing quota directories and can retry on the same filesystem', async () => {
    const { current, root, slots, oldSource, newSource } = await quotaRelocationFixture()
    commands.beforeRename.mockRejectedValueOnce(Object.assign(new Error('Cross-device move'), { code: 'EXDEV' }))
    expect(await relocateCiQuotaSlots(current, root)).toBeNull()
    for (const slot of slots) {
      expect(await readFile(join(oldSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
      await expect(stat(join(newSource, slot.namespace))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await relocateCiQuotaSlots(current, root)).toEqual(current.descriptor.quotaPool)
    for (const slot of slots) {
      expect(await readFile(join(newSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
      await expect(stat(join(oldSource, slot.namespace))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('preserves unexpected relocation errors and the original quota data', async () => {
    const { current, root, slots, oldSource } = await quotaRelocationFixture()
    commands.beforeRename.mockRejectedValueOnce(Object.assign(new Error('Move denied'), { code: 'EACCES' }))
    await expect(relocateCiQuotaSlots(current, root)).rejects.toMatchObject({ code: 'EACCES' })
    for (const slot of slots) {
      expect(await readFile(join(oldSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
    }
  })

  it('does not schedule a restart or replace the configuration when quota relocation is skipped', async () => {
    const { current, root, slots, oldSource, directory } = await quotaRelocationFixture()
    const configurationPath = join(directory, 'job-runtime.json')
    const bytes = JSON.stringify(current)
    await writeFile(configurationPath, bytes, { mode: 0o600 })
    const prepared = { ...fixture().prepared, seedReceiptPath: join(directory, 'prepared-seed.json') }
    await writeFile(prepared.seedReceiptPath, '{}')
    commands.beforeRename.mockRejectedValueOnce(Object.assign(new Error('Cross-device move'), { code: 'EXDEV' }))
    await expect(scheduleCiRuntimeRefresh({ operationId: randomUUID(), stateDirectory: directory, prepared,
      root, manifest: current.qualificationSource.manifest, resources: current.machine.resources,
      drain: async () => {} })).rejects.toMatchObject({ code: 'CI_RUNTIME_RELOCATION_REQUIRED' })
    expect(commands.run).not.toHaveBeenCalled()
    expect(await readFile(configurationPath, 'utf8')).toBe(bytes)
    expect(await readdir(join(directory, 'managed', 'ci'))).toEqual([])
    expect(await readFile(prepared.seedReceiptPath, 'utf8')).toBe('{}')
    for (const slot of slots) {
      expect(await readFile(join(oldSource, slot.namespace, 'retained'), 'utf8')).toBe(slot.namespace)
    }
  })

  it.each(['installation', 'tools', 'submission'])('leaves no copied refresh inputs after %s failure', async failure => {
    const { current, root, directory } = await quotaRelocationFixture()
    const configurationPath = join(directory, 'job-runtime.json')
    const bytes = JSON.stringify(current)
    if (failure !== 'installation') await writeFile(configurationPath, bytes, { mode: 0o600 })
    const prepared = { ...fixture().prepared, seedReceiptPath: join(directory, 'prepared-seed.json') }
    await writeFile(prepared.seedReceiptPath, 'original prepared receipt')
    const work = join(directory, 'managed', 'ci')
    await mkdir(work, { recursive: true, mode: 0o700 })
    await writeFile(join(work, 'installed-seed-receipt-leaked.json'), 'old leaked receipt')
    const rejected = new Error(`${failure} rejected`)
    commands.run.mockImplementation(async (file: string, args: string[]) => {
      if (failure === 'tools' || file === 'systemd-run') throw rejected
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'image tool')
      return 'tool version'
    })
    const scheduled = scheduleCiRuntimeRefresh({ operationId: randomUUID(), stateDirectory: directory,
      prepared, root, manifest: current.qualificationSource.manifest, resources: current.machine.resources,
      drain: async () => {} })
    if (failure === 'installation') {
      await expect(scheduled).rejects.toMatchObject({ code: 'CI_RUNTIME_INSTALLATION_MISSING' })
    } else {
      await expect(scheduled).rejects.toBe(rejected)
      expect(await readFile(configurationPath, 'utf8')).toBe(bytes)
    }
    expect((await readdir(work)).filter(name => name.startsWith('installed-seed-receipt-')
      || name.startsWith('reviewed-refresh-'))).toEqual([])
    expect(await readFile(prepared.seedReceiptPath, 'utf8')).toBe('original prepared receipt')
  })

  it('preserves scheduled refresh inputs until the service consumes them', async () => {
    const { current, root, directory } = await quotaRelocationFixture()
    await writeFile(join(directory, 'job-runtime.json'), JSON.stringify(current), { mode: 0o600 })
    const prepared = { ...fixture().prepared, seedReceiptPath: join(directory, 'prepared-seed.json') }
    await writeFile(prepared.seedReceiptPath, 'prepared receipt')
    commands.run.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'image tool')
      return 'tool version'
    })
    const operationId = randomUUID()
    const result = await scheduleCiRuntimeRefresh({ operationId, stateDirectory: directory, prepared, root,
      manifest: current.qualificationSource.manifest, resources: current.machine.resources, drain: async () => {} })
    expect(result).toEqual({ unit: `foreman-ci-refresh-${operationId}`, workerUnit: 'worker.service' })
    const work = join(directory, 'managed', 'ci')
    const seedReceiptPath = join(work, `installed-seed-receipt-${operationId}.json`)
    expect(await readFile(seedReceiptPath, 'utf8')).toBe('prepared receipt')
    const reviewed = JSON.parse(await readFile(join(work, `reviewed-refresh-${operationId}.json`), 'utf8'))
    expect(reviewed.captureInput.seedReceiptPath).toBe(seedReceiptPath)
    expect(commands.run).toHaveBeenCalledWith('systemd-run', expect.any(Array))
  })

  it('captures the new pairing target from its fresh source binding without relabelling historical inputs', () => {
    const f = fixture()
    const mainId = randomUUID()
    const deviceId = randomUUID()
    const workerInstallationId = randomUUID()
    const root = { ...f.current.root,
      selection: { ...f.current.root.selection, hostRef: { kind: 'device' as const, mainId, deviceId } },
      registration: { workerInstallationId, keyRevision: 2, authorizationRevision: 3 },
      binding: { ...f.current.root.binding, mainId, deviceId, workerInstallationId } }
    const next = nextCaptureInput(f.current, f.prepared, { root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources })
    expect(next.descriptor.target).toEqual({ hostRef: root.selection.hostRef,
      registration: root.registration, mainInstallationId: mainId })
    expect(f.current.descriptor.target.mainInstallationId).not.toBe(mainId)
    expect(next.root).toEqual(root)
    expect(next.machine).not.toHaveProperty('bootId')
    expect(next.machine).not.toHaveProperty('runtimeBinarySha256')
  })
  it('captures a project runtime without claiming a Codex binary that it does not contain', async () => {
    const f = fixture()
    delete f.prepared.unitCodex
    const directory = await privateFixtureDirectory('ci-project-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'image tool')
      if (args.includes('run')) return 'postgres (PostgreSQL) 17.2'
      return ''
    })
    const tools = await recaptureCiTools(f.current.machine.tools, f.prepared, directory, process.env)
    expect(tools.some(tool => tool.kind === 'codex')).toBe(false)
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources })
    expect(next.toolSources.some(tool => tool.kind === 'codex')).toBe(false)
  })

  it('captures PostgreSQL from the image when the previous unit-only runtime had no database identity', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-integration-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'postgres-image-binary')
      if (args.includes('run')) return 'postgres (PostgreSQL) 17.6'
      return ''
    })
    const sources = await recaptureCiTools(f.current.machine.tools.filter(tool => tool.kind === 'codex'),
      f.prepared, directory, process.env)
    const database = sources.find(tool => tool.kind === 'postgresql')
    expect(database).toMatchObject({ executable: '/usr/lib/postgresql/17/bin/postgres', version: '17.6' })
    expect(await readFile(database!.sourceExecutable, 'utf8')).toBe('postgres-image-binary')
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources, toolSources: sources })
    expect(next.toolSources).toContainEqual(database)
  })

  it('retains the identities needed by integration, browser and native suites in the capture input', () => {
    const f = fixture()
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources })
    expect(next.toolSources.map(tool => tool.kind).sort()).toEqual(['browser', 'claude', 'codex', 'postgresql'])
    expect(next.toolSources.find(tool => tool.kind === 'codex')).toMatchObject({ version: 'new-codex',
      sourceExecutable: '/ci/prepared-codex' })
  })

  it('recaptures each non-Codex tool from the prepared image rather than carrying old binary identities', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, `new:${args.at(-2)}`)
      if (args.includes('run')) return args.some(arg => arg.includes('postgres')) ? 'postgres (PostgreSQL) 17.2' : 'new-version'
      return ''
    })
    const sources = await recaptureCiTools(f.current.machine.tools, f.prepared, directory, process.env)
    expect(sources.map(tool => tool.kind).sort()).toEqual(['browser', 'claude', 'codex', 'postgresql'])
    expect(sources.find(tool => tool.kind === 'postgresql')?.version).toBe('17.2')
    for (const tool of sources.filter(value => value.kind !== 'codex')) {
      const bytes = await readFile(tool.sourceExecutable)
      expect(bytes.toString()).toBe(`new:container:${tool.executable}`)
      expect(createHash('sha256').update(bytes).digest('hex'))
        .not.toBe(f.current.machine.tools.find(value => value.kind === tool.kind)!.binarySha256)
    }
  })

  describe('Main refresh', () => {
    async function mainRefresh(change?: 'configuration' | 'target') {
      const f = fixture()
      const directory = await privateFixtureDirectory('ci-main-refresh-')
      roots.push(directory)
      const current = { ...f.current, descriptor: { ...f.current.descriptor, runtimeRoot: directory } }
      const currentBytes = Buffer.from(JSON.stringify(current))
      await writeFile(join(directory, 'job-runtime.json'), currentBytes, { mode: 0o600 })
      const captureInput = nextCaptureInput(current, f.prepared, { root: current.root,
        manifest: current.qualificationSource.manifest, seedReceiptPath: '/ci/installed-seed.json',
        resources: current.descriptor.resources })
      if (change === 'target') captureInput.descriptor.target = { ...captureInput.descriptor.target, mainInstallationId: 'other-main' }
      const captured = { ...current, machine: { ...current.machine, imageDigest: f.prepared.imageId } }
      capture.record.mockResolvedValue(captured)
      const inputPath = join(directory, 'reviewed.json')
      await writeFile(inputPath, JSON.stringify({ expectedConfigurationSha256: createHash('sha256').update(currentBytes).digest('hex'),
        captureInput }), { mode: 0o600 })
      if (change === 'configuration') await writeFile(join(directory, 'job-runtime.json'), `${currentBytes}\n`, { mode: 0o600 })
      return { directory, inputPath, currentBytes, captured, captureInput }
    }

    it('captures the next protected configuration and keeps the previous one for accepted Jobs', async () => {
      const r = await mainRefresh()
      const result = await refreshMainJobRuntime({ stateDirectory: r.directory, inputPath: r.inputPath })
      expect(capture.record).toHaveBeenCalledWith(r.captureInput)
      const digest = createHash('sha256').update(r.currentBytes).digest('hex')
      expect(result.previousConfigurationPath).toBe(join(r.directory, `job-runtime-${digest}.json`))
      expect(await readFile(result.previousConfigurationPath)).toEqual(r.currentBytes)
      expect(JSON.parse(await readFile(join(r.directory, 'job-runtime.json'), 'utf8'))).toEqual(r.captured)
      expect(((await stat(join(r.directory, 'job-runtime.json'))).mode & 0o777)).toBe(0o600)
    })

    it.each(['configuration', 'target'] as const)('refuses a refresh after a changed %s', async change => {
      const r = await mainRefresh(change)
      const before = await readFile(join(r.directory, 'job-runtime.json'))
      await expect(refreshMainJobRuntime({ stateDirectory: r.directory, inputPath: r.inputPath })).rejects.toThrow()
      expect(await readFile(join(r.directory, 'job-runtime.json'))).toEqual(before)
      expect((await readdir(r.directory)).sort()).toEqual(['job-runtime.json', 'reviewed.json'])
    })
  })

  it('retires previous configurations whose image nothing still uses and keeps the current one', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-retention-')
    roots.push(directory)
    const used = `sha256:${'c'.repeat(64)}`, unused = `sha256:${'d'.repeat(64)}`
    const previous = (image: string, source: string) => JSON.stringify({ ...f.current,
      machine: { ...f.current.machine, imageDigest: image },
      seedReceiptPath: source + '-seed.json',
      qualificationSource: { ...f.current.qualificationSource, directory: source } })
    await writeFile(join(directory, 'job-runtime.json'), JSON.stringify(f.current))
    await writeFile(join(directory, `job-runtime-${'b'.repeat(64)}.json`), previous(used, '/ci/installer/qualification-source-used'))
    await writeFile(join(directory, `job-runtime-${'e'.repeat(64)}.json`), previous(unused, '/ci/installer/qualification-source-old'))
    const retained = await retireCiRuntimeConfigurations(directory, [used])
    expect(retained.images.sort()).toEqual([f.current.machine.imageDigest, used].sort())
    expect(retained.paths.sort()).toEqual([f.current.qualificationSource.directory, f.current.seedReceiptPath,
      '/ci/installer/qualification-source-used', '/ci/installer/qualification-source-used-seed.json'].sort())
    expect((await readdir(directory)).sort()).toEqual(['job-runtime.json', `job-runtime-${'b'.repeat(64)}.json`].sort())
  })

  it('preserves the current qualification source and its seed receipt before preparation', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-current-paths-')
    roots.push(directory)
    await writeFile(join(directory, 'job-runtime.json'), JSON.stringify(f.current), { mode: 0o600 })
    expect(await currentCiRuntimePaths(directory))
      .toEqual([f.current.qualificationSource.directory, f.current.seedReceiptPath])
  })

  it('schedules the Worker stop only after both its active Job and Agent session finish', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-refresh-')
    roots.push(directory)
    const stateDirectory = join(directory, 'state')
    await mkdir(stateDirectory)
    await writeFile(join(stateDirectory, 'job-runtime.json'), JSON.stringify(f.current), { mode: 0o600 })
    const seedReceiptPath = join(directory, 'prepared-seed.json')
    await writeFile(seedReceiptPath, '{}')
    const work = join(stateDirectory, 'managed', 'ci')
    await mkdir(work, { recursive: true })
    const stale = join(work, 'refresh-stale.log')
    await writeFile(stale, 'old refresh')
    const operationId = randomUUID()
    let finishJob!: () => void
    let finishAgent!: () => void
    let beganDrain!: () => void
    const draining = new Promise<void>(resolve => { beganDrain = resolve })
    const job = new Promise<void>(resolve => { finishJob = resolve })
    const agent = new Promise<void>(resolve => { finishAgent = resolve })
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'new-binary')
      return 'new-version'
    })
    const refreshing = scheduleCiRuntimeRefresh({ operationId, stateDirectory,
      prepared: { ...f.prepared, seedReceiptPath },
      root: f.current.root, manifest: f.current.qualificationSource.manifest, resources: f.current.machine.resources,
      drain: async () => { beganDrain(); await Promise.all([job, agent]) } })
    try {
      const first = await Promise.race([draining.then(() => 'draining'), refreshing.then(() => 'scheduled')])
      expect(first).toBe('draining')
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(false)
      finishJob()
      await Promise.resolve()
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(false)
      finishAgent()
      expect(await refreshing).toMatchObject({ workerUnit: 'worker.service' })
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(true)
      await expect(readFile(stale)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(work, `installed-seed-receipt-${operationId}.json`), 'utf8')).toBe('{}')
      expect(JSON.parse(await readFile(join(work, `reviewed-refresh-${operationId}.json`), 'utf8')))
        .toHaveProperty('captureInput')
    } finally { finishJob(); finishAgent(); await refreshing }
  })

  it('automatically schedules initial capture from adopted installation inputs', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-initial-capture-')
    roots.push(directory)
    await writeFile(join(directory, 'ci-runtime-installation.json'), JSON.stringify({ schemaVersion: 1,
      target: f.current.descriptor.target, runtime: f.current }), { mode: 0o600 })
    const seedReceiptPath = join(directory, 'prepared-seed.json')
    await writeFile(seedReceiptPath, '{}', { mode: 0o600 })
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'new-binary')
      return 'new-version'
    })
    const operationId = randomUUID()
    await scheduleCiRuntimeRefresh({ operationId, stateDirectory: directory,
      prepared: { ...f.prepared, seedReceiptPath }, root: f.current.root,
      manifest: f.current.qualificationSource.manifest, resources: f.current.machine.resources,
      drain: async () => {} })
    const call = commands.run.mock.calls.find(([file]) => file === 'systemd-run')!
    expect(call[1]).toContain('capture-job-runtime')
    expect(call[1]).not.toContain('refresh-job-runtime')
    const captured = JSON.parse(await readFile(join(directory, 'managed', 'ci', `reviewed-refresh-${operationId}.json`), 'utf8'))
    expect(captured.schemaVersion).toBe(2)
    expect(captured.descriptor.target).toEqual(f.current.descriptor.target)
    expect(captured).not.toHaveProperty('expectedConfigurationSha256')
  })
})
