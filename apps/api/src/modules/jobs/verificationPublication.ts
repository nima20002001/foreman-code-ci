import { jobLifecycleSignal } from './lifecycle.js'
import { constants, openSync, fstatSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { open, rm, readdir, lstat, realpath, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { finalizeVerification } from '../../../../../scripts/verification-runner.mjs'
import { JobVerificationReportSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { RemoteJobTerminalEvidence } from '@foreman-code/contracts/remote-job-execution'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { JobVerificationRepositoryContextSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { z } from 'zod'
import type { VerificationReportReserve } from './executorOutputs.js'
import { JobOutputCollectionError, writeVerificationInterruptionReport } from './executorOutputs.js'

/** Uses the installed module's bytes, retained context and original terminal receipt on either host. */
export function createVerificationPublication(journal: RemoteOperationJournal) {
  return async (execution: JobExecutionRecord, terminal: RemoteJobTerminalEvidence): Promise<void> => {
    if (execution.schemaVersion !== 2) return
    if (!terminal.processStopped) throw new JobOutputCollectionError('Physical closure required before finalization.')
    const retained = (await journal.jobNativeOwner(execution.operationId))?.verification
    if (!retained) throw new JobOutputCollectionError('Original report reservation is missing.')
    return finalizeVerificationPublication(execution, terminal, retained,
      finishedAt => journal.jobVerificationFinalized(execution.operationId, finishedAt))
  }
}

export async function finalizeVerificationPublication(
  execution: JobExecutionRecord,
  terminal: RemoteJobTerminalEvidence,
  retained: { context: z.infer<typeof JobVerificationRepositoryContextSchema>;
    reserve: VerificationReportReserve; finalizedAt: string | null },
  markFinalized: (finishedAt: string) => Promise<unknown>,
): Promise<void> {
    if (execution.schemaVersion !== 2 || !terminal.processStopped) {
      throw new JobOutputCollectionError('Closed verification execution required for finalization.')
    }
    const reservedPath = join(retained.reserve.parent, retained.reserve.name)
    if (retained.finalizedAt) {
      await rm(reservedPath, { force: true })
      return
    }
    const signal = jobLifecycleSignal(execution, 'publication')
    const checkpoint = () => {
      signal.throwIfAborted()
      if (Date.now() >= Date.parse(execution.acceptedSpec.lifecycle.publicationDeadlineAt)) {
        throw new JobOutputCollectionError('Original Job publication deadline expired.')
      }
    }
    checkpoint()
    const root = execution.acceptedSpec.target.destination.canonicalProjectRoot
    const directory = join(root, '.logs/verification')
    const reserve = retained.reserve
    const existing = await readRetainedReport(join(directory, 'summary.json'), retained.context.limits.summaryBytes)
      .catch(error => {
        if (error instanceof SyntaxError || error.code === 'ENOENT') return null
        throw error
      })
    const parsed = JobVerificationReportSchema.safeParse(existing)
    const existingStat = await lstat(join(directory, 'summary.json')).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existingStat?.dev === reserve.device && existingStat.ino === reserve.inode
      && parsed.success && parsed.data.finishedAt === terminal.finishedAt
      && Object.entries(retained.context.identity).every(([key, value]) =>
        isDeepStrictEqual(Reflect.get(parsed.data, key), value))) {
      for (const declaration of execution.acceptedSpec.outputs) {
        checkpoint()
        const path = join(root, declaration.path)
        const canonical = await realpath(path).catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (canonical && canonical !== path) throw new JobOutputCollectionError('Declared report path changed.')
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          .catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (file) {
          try { await file.sync() } finally { await file.close() }
        }
      }
      await markFinalized(terminal.finishedAt)
      await rm(reservedPath, { force: true })
      return
    }
    const file = await open(reservedPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== reserve.device || stat.ino !== reserve.inode) {
        throw new JobOutputCollectionError('Original report reservation changed.')
      }
      // Quiescent workload caches can be removed before consuming the protected report allowance.
      const cleanup = jobLifecycleSignal(execution, 'cleanup')
      cleanup.throwIfAborted()
      const caches = [join(reserve.parent, 'job-scratch')]
      if (!execution.acceptedSpec.outputs.some(output => output.path.startsWith('node_modules/'))) {
        caches.push(join(root, 'node_modules'))
      }
      for (const path of caches) {
        cleanup.throwIfAborted()
        await removeClosedWorkload(path, cleanup)
      }
      await file.truncate(0)
      await file.sync()
    } finally { await file.close() }
    signal.throwIfAborted()
    let state: { identity: unknown; startedAt: string; expected: Array<{ key: string; kind: string }> }
    try {
      state = await readRetainedReport(join(directory, 'parts/state.json'), retained.context.limits.vitestBytes) as typeof state
      if (!isDeepStrictEqual(state.identity, retained.context.identity)) throw new Error('Retained report identity changed.')
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      state = { identity: retained.context.identity, startedAt: execution.startedAt ?? execution.createdAt,
        expected: retained.context.requiredPortions }
    }
    let outcome = 'failed'
    if (terminal.outcome === 'succeeded') outcome = 'passed'
    if (terminal.outcome === 'cancelled') outcome = 'cancelled'
    if (terminal.outcome === 'timed_out') outcome = 'timed_out'
    try {
      signal.throwIfAborted()
      finalizeVerification(retained.context, { root, directory, state,
        terminalOutcome: outcome, processStopped: true, finishedAt: terminal.finishedAt, reportRoot: '/workspace', checkpoint,
        writeSummary(path, report, maximumBytes) {
          checkpoint()
          const bytes = Buffer.from(JSON.stringify(report))
          if (bytes.length > Math.min(maximumBytes, reserve.bytes)) {
            throw new JobOutputCollectionError('Summary exceeds its protected report allowance.')
          }
          const fd = openSync(reservedPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const stat = fstatSync(fd)
            if (stat.dev !== reserve.device || stat.ino !== reserve.inode || stat.nlink !== 1 || !stat.isFile()) {
              throw new JobOutputCollectionError('Original report reservation changed.')
            }
            writeFileSync(fd, bytes)
            fsyncSync(fd)
          } finally { closeSync(fd) }
          renameSync(reservedPath, path)
          for (const directory of [reserve.parent, dirname(path)]) {
            const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            try { fsyncSync(fd) } finally { closeSync(fd) }
          }
        },
      })
      checkpoint()
    } catch (error) {
      if (terminal.outcome === 'succeeded'
        || Date.now() >= Date.parse(execution.acceptedSpec.lifecycle.publicationDeadlineAt)) throw error
      await writeVerificationInterruptionReport({ execution, terminal, reserve })
    }
    await markFinalized(terminal.finishedAt)
    await rm(reservedPath, { force: true })
}

async function removeClosedWorkload(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stat = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await readdir(path)) await removeClosedWorkload(join(path, name), signal)
  }
  signal.throwIfAborted()
  await rm(path, { recursive: false, force: true }).catch(async error => {
    if (error.code !== 'ERR_FS_EISDIR' && error.code !== 'EISDIR') throw error
    await rmdir(path)
  })
  signal.throwIfAborted()
}

async function readRetainedReport(path: string, maximumBytes: number): Promise<unknown> {
  if (await realpath(path) !== path) throw new JobOutputCollectionError('Retained report path changed.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
      throw new JobOutputCollectionError('Retained report exceeds its declared type or byte limit.')
    }
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}
