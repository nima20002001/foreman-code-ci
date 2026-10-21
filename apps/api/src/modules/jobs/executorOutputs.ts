import { constants } from 'node:fs'
import { mkdir, open, rename, type FileHandle } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AcceptedJobSpec } from '@foreman-code/contracts'
import type { RemoteJobTerminalEvidence } from '@foreman-code/contracts/remote-job-execution'
import { JobOrdinaryVerificationSuiteSchema, JobVerificationPassSchema, JobVerificationReportSchema, VerificationJobExecutionSchema,
  type AcceptedVerificationJobSpec, type JobVerificationReport }
  from '@foreman-code/contracts/job-verification'
import { z } from 'zod'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { JobVerificationRuntimeMeasurementSchema, JobVerificationPrivateGitSchema,
  JobVerificationPreseedFactsSchema, JobVerificationRepositoryContextSchema, type JobVerificationRuntimeMeasurement }
  from '@foreman-code/contracts/job-verification-runtime'
import { jobSupervisorIdentity } from './executor.js'
import { requireJobGitMounts, type VerifiedJobGitMounts } from './privateGitMounts.js'

export class JobOutputCollectionError extends Error {}

/** Called by W09 only after container/descendant quiescence is positively proven. */
export async function readDeclaredJobOutputs(root: string, spec: AcceptedJobSpec | AcceptedVerificationJobSpec): Promise<Array<{ path: string; bytes: Buffer }>> {
  return readJobOutputs(root, spec, 'require-all')
}

export async function readAvailableVerificationOutputs(root: string, spec: AcceptedVerificationJobSpec) {
  return readJobOutputs(root, spec, 'retain-available')
}

export async function readBoundedJobFile(root: string, path: string, maximumBytes: number): Promise<Buffer> {
  const files = await readJobOutputs(root, { outputs: [{ path, required: true, maxBytes: maximumBytes }],
    policy: { maxOutputBytes: maximumBytes } }, 'require-all')
  return files[0]!.bytes
}

async function readJobOutputs(root: string, spec: {
  outputs: readonly { path: string; required: boolean; maxBytes?: number }[];
  policy: { maxOutputBytes: number } },
  missingReports: 'require-all' | 'retain-available'): Promise<Array<{ path: string; bytes: Buffer }>> {
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(error => { throw new JobOutputCollectionError('Declared Job output root unavailable.', { cause: error }) })
  const outputs: Array<{ path: string; bytes: Buffer }> = []
  let total = 0
  try {
    for (const output of spec.outputs) {
      const directories: FileHandle[] = []
      let file: FileHandle | undefined
      try {
        let parent = rootHandle
        const parts = output.path.split('/')
        if (parts.some(part => !part || part === '.' || part === '..') || output.path.startsWith('/') || output.path.includes('\\')) {
          throw new Error('Invalid declared output path.')
        }
        for (const part of parts.slice(0, -1)) {
          parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          directories.push(parent)
        }
        file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = await file.stat()
        const limit = output.maxBytes !== undefined ? Math.min(output.maxBytes, spec.policy.maxOutputBytes - total)
          : spec.policy.maxOutputBytes - total
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new JobOutputCollectionError('Output type or byte budget rejected.')
        const bytes = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!read.bytesRead) throw new JobOutputCollectionError('Output changed during collection.')
          offset += read.bytesRead
        }
        const after = await file.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new JobOutputCollectionError('Output changed during collection.')
        total += bytes.length
        outputs.push({ path: output.path, bytes })
      } catch (error) {
        const unavailable = error instanceof Error && 'code' in error
          && ['ENOENT', 'ELOOP', 'ENOTDIR'].includes(String(error.code))
        if (missingReports === 'retain-available' && (unavailable || error instanceof JobOutputCollectionError)) continue
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
        if (output.required || !missing) throw error
      } finally {
        await file?.close()
        await Promise.all(directories.map(directory => directory.close()))
      }
    }
    return outputs
  } catch (error) { throw new JobOutputCollectionError(error instanceof Error && !('code' in error) ? error.message : 'Declared Job output collection failed.', { cause: error }) } finally { await rootHandle.close() }
}

type VerificationExecution = z.infer<typeof VerificationJobExecutionSchema>

/** Seed facts come from the reviewed image receipt; the context is delivered by the immutable W09 input path. */
export function verificationRepositoryContext(input: {
  execution: VerificationExecution
  measurement: JobVerificationRuntimeMeasurement
  preseedFacts: unknown
  gitMounts: VerifiedJobGitMounts
  requiredPortions: z.infer<typeof JobVerificationRepositoryContextSchema>['requiredPortions']
}) {
  const execution = VerificationJobExecutionSchema.parse(input.execution)
  const measured = JobVerificationRuntimeMeasurementSchema.parse(input.measurement)
  const spec = execution.acceptedSpec
  const mounts = requireJobGitMounts(execution, { gitMounts: input.gitMounts })
  const { sourceCommit, generatedCommit, repositoryReceiptDigest, configDigest, indexDigest } = mounts.git
  const privateGit = JobVerificationPrivateGitSchema.parse({
    sourceCommit, generatedCommit, repositoryReceiptDigest, configDigest, indexDigest,
  })
  const suite = measured.suites.find(value => value.suite === spec.verification.suite)
  if (!suite || !isDeepStrictEqual(spec.profile, measured.identity)
    || !JobOrdinaryVerificationSuiteSchema.safeParse(spec.verification.suite).success
    || spec.verification.parameters.unitWorkers > Math.min(suite.maxUnitWorkers, JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers)
    || spec.verification.parameters.integrationShards > suite.maxIntegrationShards) {
    throw new Error('Matching ordinary-suite qualification required for wrapper context.')
  }
  const output = (kind: string, path: string) => {
    const declaration = spec.outputs.find(value => value.kind === kind && value.path === path && value.required)
    if (!declaration) throw new Error('Declare every fixed verification report with an explicit required byte limit.')
    return declaration.maxBytes
  }
  const summaryBytes = output('suite-summary', '.logs/verification/summary.json')
  const junitBytes = output('junit', '.logs/verification/junit.xml')
  const vitestBytes = output('vitest-json', '.logs/verification/vitest.json')
  const logsArchiveBytes = output('logs-archive', '.logs/verification/logs.tar.gz')
  const identity = JobVerificationPassSchema.shape.expected.parse({ commit: spec.source.commit,
    manifestDigest: spec.source.manifestDigest, definitionVersionId: spec.definitionVersionId,
    suite: spec.verification.suite, executionId: execution.id, attemptId: execution.attemptId,
    target: spec.target, profile: spec.profile, resources: spec.verification.resources,
    parameters: spec.verification.parameters })
  const codex = measured.fingerprint.tools.find(tool => tool.kind === 'codex')
  if (spec.verification.suite === 'unit' && (!codex || codex.executable !== '/opt/graphql-ci/tools/codex')) {
    throw new Error('Unit verification requires its qualified image Codex schema binary.')
  }
  return { identity, privateGit, requiredPortions: input.requiredPortions,
    ...(codex ? { unitCodex: { executable: codex.executable, version: codex.version,
      binarySha256: codex.binarySha256 } } : {}), executionTimeoutMs: spec.policy.executionTimeoutMs,
    cancellationTimeoutMs: spec.policy.cancellationGraceMs, qualifiedUnitWorkers: Math.min(suite.maxUnitWorkers, JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers),
    qualifiedIntegrationShards: suite.maxIntegrationShards,
    limits: { summaryBytes, junitBytes, vitestBytes, logsArchiveBytes,
      logBytes: Math.min(spec.policy.maxLogBytes, logsArchiveBytes) },
    mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
    preseedReceipt: JobVerificationPreseedFactsSchema.parse(input.preseedFacts) }
}

export interface VerificationReportReserve {
  parent: string
  name: string
  device: number
  inode: number
  bytes: number
}

async function openReportParent(sourceRoot: string, path: string, options: { create: boolean }) {
  const handles: FileHandle[] = []
  try {
    let parent = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(parent)
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..') || path.includes('\\')) {
      throw new JobOutputCollectionError('Invalid declared interruption report path.')
    }
    for (const part of parts.slice(0, -1)) {
      const directory = `/proc/self/fd/${parent.fd}/${part}`
      if (options.create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(parent)
    }
    return { handles, parent, path: `/proc/self/fd/${parent.fd}/${parts.at(-1)!}` }
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close()
    throw error
  }
}

/** Allocate report capacity outside every container mount before native entry. */
export async function reserveVerificationReportSpace(raw: VerificationExecution, signal?: AbortSignal): Promise<VerificationReportReserve> {
  signal?.throwIfAborted()
  const execution = VerificationJobExecutionSchema.parse(raw)
  const parent = dirname(execution.acceptedSpec.target.destination.canonicalProjectRoot)
  const name = `.${jobSupervisorIdentity(execution)}-report-reserve`
  const bytes = execution.acceptedSpec.verification.resources.reportBytes
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let file: FileHandle | undefined
  try {
    const owner = await directory.stat()
    signal?.throwIfAborted()
    if (owner.uid !== process.getuid?.() || owner.mode & 0o077) throw new Error('Private report reservation namespace required.')
    const declaration = execution.acceptedSpec.outputs.find(output => output.kind === 'suite-summary' && output.required)!
    const report = await openReportParent(execution.acceptedSpec.target.destination.canonicalProjectRoot,
      declaration.path, { create: true })
    try {
      const placeholder = await open(report.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        .catch(error => { if (error.code === 'EEXIST') return null; throw error })
      if (placeholder) {
        try { await placeholder.sync() } finally { await placeholder.close() }
      }
      await report.parent.sync()
    } finally { for (const handle of report.handles.reverse()) await handle.close() }
    const path = `/proc/self/fd/${directory.fd}/${name}`
    let created = true
    file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(async error => {
        if (error.code !== 'EEXIST') throw error
        created = false
        return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      })
    const original = await file.stat()
    if (!original.isFile() || original.nlink !== 1 || original.uid !== owner.uid || original.mode & 0o077
      || (!created && (original.size !== bytes || original.blocks * 512 < bytes))) {
      throw new Error('Original allocated report reservation requires reconciliation.')
    }
    if (!created) return { parent, name, device: original.dev, inode: original.ino, bytes }
    const zeroes = Buffer.alloc(Math.min(bytes, 65536))
    let offset = 0
    while (offset < bytes) {
      signal?.throwIfAborted()
      const written = await file.write(zeroes, 0, Math.min(zeroes.length, bytes - offset), offset)
      if (!written.bytesWritten) throw new Error('Report reservation allocation incomplete.')
      offset += written.bytesWritten
    }
    await file.sync()
    const info = await file.stat()
    if (info.size !== bytes || info.blocks * 512 < bytes) throw new Error('Report reserve must have physical allocation.')
    await directory.sync()
    signal?.throwIfAborted()
    return { parent, name, device: info.dev, inode: info.ino, bytes }
  } finally {
    await file?.close()
    await directory.close()
  }
}

/** Called with the original persisted terminal evidence, after container and controller descendant closure. */
export async function writeVerificationInterruptionReport(input: {
  execution: VerificationExecution
  terminal: RemoteJobTerminalEvidence
  reserve: VerificationReportReserve
}): Promise<void> {
  const execution = VerificationJobExecutionSchema.parse(input.execution)
  const spec = execution.acceptedSpec
  const terminal = input.terminal
  if (!terminal.processStopped || !['cancelled', 'timed_out', 'build_failed', 'spawn_failed'].includes(terminal.outcome)) {
    throw new JobOutputCollectionError('Interruption reporting requires a confirmed closed unsuccessful process.')
  }
  const declaration = spec.outputs.find(output => output.kind === 'suite-summary' && output.required)!
  const reserve = input.reserve
  const sourceRoot = spec.target.destination.canonicalProjectRoot
  if (reserve.parent !== dirname(sourceRoot) || reserve.name !== `.${jobSupervisorIdentity(execution)}-report-reserve`
    || reserve.bytes !== spec.verification.resources.reportBytes) throw new JobOutputCollectionError('Original report reserve changed.')
  const directory = await open(reserve.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const handles: FileHandle[] = []
  try {
    const reservedPath = `/proc/self/fd/${directory.fd}/${reserve.name}`
    const reportParent = await openReportParent(`/proc/self/fd/${directory.fd}/${basename(sourceRoot)}`,
      declaration.path, { create: false })
    handles.push(...reportParent.handles)
    const { parent, path } = reportParent
    let outcome: JobVerificationReport['outcome'] = 'incomplete'
    if (terminal.outcome === 'cancelled') outcome = 'cancelled'
    if (terminal.outcome === 'timed_out') outcome = 'timed_out'
    let report = JobVerificationReportSchema.parse({ schemaVersion: 1,
      commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
      definitionVersionId: spec.definitionVersionId, suite: spec.verification.suite,
      executionId: execution.id, attemptId: execution.attemptId, target: spec.target,
      profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
      startedAt: execution.startedAt ?? execution.createdAt, finishedAt: terminal.finishedAt,
      totals: { total: 0, passed: 0, failed: 0, skipped: 0 }, firstPassFailed: 0,
      expectedPortions: 1, completedPortions: 0, disallowedSkipped: 0, completeness: 'partial',
      outcome,
    })
    const reserved = await open(reservedPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (reserved) {
      handles.push(reserved)
      const info = await reserved.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077
        || info.dev !== reserve.device || info.ino !== reserve.inode || info.size > reserve.bytes) {
        throw new JobOutputCollectionError('Report reserve identity changed.')
      }
    }
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      try {
        const info = await existing.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size > declaration.maxBytes) throw new Error('Report file rejected.')
        const parsed = JobVerificationReportSchema.safeParse(JSON.parse(await existing.readFile('utf8')))
        if (parsed.success && ['commit', 'manifestDigest', 'definitionVersionId', 'suite', 'executionId', 'attemptId',
          'target', 'profile', 'resources', 'parameters'].every(field =>
          isDeepStrictEqual(Reflect.get(parsed.data, field), Reflect.get(report, field)))) {
          if (!reserved && info.dev === reserve.device && info.ino === reserve.inode
            && parsed.data.finishedAt === terminal.finishedAt && parsed.data.outcome === report.outcome
            && parsed.data.completeness === 'partial') return
          if (!['cancelled', 'timed_out'].includes(terminal.outcome) && parsed.data.outcome !== 'passed') return
          report = { ...parsed.data, finishedAt: terminal.finishedAt, completeness: 'partial', outcome: report.outcome }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      } finally { await existing.close() }
    }
    if (!reserved) throw new JobOutputCollectionError('Original report reserve or its completed partial report is missing.')
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`)
    if (bytes.length > Math.min(declaration.maxBytes, spec.policy.maxOutputBytes, reserve.bytes)) {
      throw new JobOutputCollectionError('Partial report exceeds its declared reservation.')
    }
    await reserved.truncate(0)
    await reserved.writeFile(bytes)
    await reserved.sync()
    await rename(reservedPath, path)
    await directory.sync()
    await parent.sync()
  } catch (error) {
    throw new JobOutputCollectionError('Partial verification report could not be written.', { cause: error })
  } finally {
    for (const handle of handles.reverse()) await handle.close()
    await directory.close()
  }
}
