import { AcceptedProviderAccountBindingSchema } from '@foreman-code/contracts/provider-accounts'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { RemoteNativeIdentitySchema, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { RemoteNativeLaunchObservationSchema, RemoteWorkflowPhysicalOutputSchema,
  RemoteWorkflowPhysicalReadoutSchema, type RemoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { RemoteEntryClosureSchema } from '@foreman-code/contracts/remote-execution-entry-closure'
import { hasPositiveRemoteEntryClosure, remoteEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import type { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { readRecord, writeRecord } from '../../harnesses/recovery/storage.js'
import { RuntimeLeafAttestationSchema } from './runtimeLeaf.js'
import { remoteWorkflowProcessDigest } from './workflowPhysicalReadout.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { HistoryObservationPages } from './historyObservationPages.js'

const CaptureSchema = z.object({
  accountBinding: AcceptedProviderAccountBindingSchema.optional(),
  version: z.literal(1), intent: DispatchIntentSchema, connection: DeviceConnectionIdentitySchema,
  native: RemoteNativeIdentitySchema, session: NativeSessionReferenceSchema,
  launch: RemoteNativeLaunchObservationSchema, runtimeLeaf: RuntimeLeafAttestationSchema,
  source: RemoteWorkflowPhysicalReadoutSchema.shape.source, approvedRoots: ApprovedRootAllowlistSchema,
}).strict()
export type InstalledWorkflowRecoveryCapture = z.infer<typeof CaptureSchema>
const EntryCaptureSchema = z.object({ accountBinding: AcceptedProviderAccountBindingSchema.optional(), version: z.literal(1), intent: DispatchIntentSchema,
  connection: DeviceConnectionIdentitySchema, owner: z.string().min(1), initialLaunchId: z.uuid() }).strict()
export type InstalledWorkflowEntryCapture = z.infer<typeof EntryCaptureSchema>

/** Pipes die with the worker; the persisted original registry still owns every descendant. */
export class InstalledWorkflowRecovery {
  readonly historyPages = new HistoryObservationPages()

  constructor(private readonly directory: string, private readonly registry: NativeProcessRegistry) {}

  private path(operationId: string) {
    return join(this.directory, `${commandInputHash(operationId).slice('sha256:'.length)}.json`)
  }

  hasCapture(operationId: string) {
    return readRecord(this.path(operationId)) !== undefined || readRecord(`${this.path(operationId)}.entry`) !== undefined
  }

  readEntry(operationId: string) {
    const raw = readRecord(`${this.path(operationId)}.entry`)
    return raw === undefined ? undefined : EntryCaptureSchema.parse(raw)
  }

  rememberEntry(raw: InstalledWorkflowEntryCapture) {
    const capture = EntryCaptureSchema.parse(raw)
    if (capture.owner !== `execution:${capture.intent.executionId}`) throw new Error('Workflow entry owner changed')
    const path = `${this.path(capture.intent.operationId)}.entry`
    const previous = readRecord(path)
    if (previous !== undefined) {
      const original = EntryCaptureSchema.parse(previous)
      const retained = { ...capture, intent: { ...capture.intent, owner: original.intent.owner },
        connection: { ...capture.connection, connectionGeneration: original.connection.connectionGeneration } }
      if (!isDeepStrictEqual(original, retained)) throw new Error('Original workflow entry changed')
      return
    }
    writeRecord(path, capture, true)
  }

  async closePendingEntry(receipt: RemoteOperationReceipt, journal: RemoteOperationJournal, signal: AbortSignal) {
    if (!receipt.entryAttempted || receipt.turnEntryAttempted || receipt.native) throw new Error('Workflow entry closure scope changed')
    let raw = readRecord(`${this.path(receipt.intent.operationId)}.entry`)
    if (raw === undefined) {
      const owner = `execution:${receipt.intent.executionId}`
      const retained = this.registry.snapshot().launches.filter(row => row.owner === owner
        && row.bootId === receipt.connection.bootId)
      if (!retained.length) throw new Error('Original workflow entry registration is missing')
      const upgraded = { version: 1 as const, intent: receipt.intent, connection: receipt.connection,
        owner, initialLaunchId: retained[0]!.launchId }
      this.rememberEntry(upgraded)
      raw = upgraded
    }
    const capture = EntryCaptureSchema.parse(raw)
    if (!isDeepStrictEqual(capture.intent, { ...receipt.intent, owner: capture.intent.owner })
      || !isDeepStrictEqual(capture.connection, receipt.connection)) throw new Error('Original workflow entry capture changed')
    if (receipt.terminal) {
      if (!hasPositiveRemoteEntryClosure(receipt)
        || receipt.terminal.entryClosure!.launches.some(launch => !isDeepStrictEqual(
          this.registry.closedRegistration(capture.owner, launch.launchId), launch))) {
        throw new Error('Original workflow entry closure changed')
      }
      if (!await this.registry.closeOwner(capture.owner, signal)) throw new Error('Original workflow entry owner is unconfirmed')
      return receipt
    }
    const launches = this.registry.snapshot().launches.filter(row => row.owner === capture.owner)
    if (!await this.registry.closeOwner(capture.owner, signal)) throw new Error('Original workflow entry owner is unconfirmed')
    const closed = launches.map(launch => this.registry.closedRegistration(capture.owner, launch.launchId))
    const initial = this.registry.closedRegistration(capture.owner, capture.initialLaunchId)
    if (!initial || closed.some(launch => !launch)) throw new Error('Original workflow entry closure observations are missing')
    if (!closed.some(launch => launch!.launchId === initial.launchId)) closed.push(initial)
    const entryClosure = RemoteEntryClosureSchema.parse({ intent: capture.intent, connection: capture.connection,
      owner: capture.owner, initialLaunchId: capture.initialLaunchId, launches: closed })
    await journal.revokeFence(receipt.intent.operationId)
    return journal.terminal(receipt.intent.operationId, { kind: 'cancelled', entryClosure,
      closureEvidenceDigest: remoteEntryClosureDigest(entryClosure) })
  }

  async rememberOutput(operationId: string, output: RemoteWorkflowPhysicalOutput) {
    const serialized = JSON.stringify(RemoteWorkflowPhysicalOutputSchema.parse(output))
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Workflow recovery output exceeds its byte limit')
    const path = `${this.path(operationId)}.output`
    const previous = await this.readOutput(operationId)
    if (previous) {
      if (!isDeepStrictEqual(previous, output)) throw new Error('Original workflow recovery output changed')
      return
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(serialized)
      await file.sync()
    } catch (error) {
      await unlink(temporary)
      throw error
    } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() }
    finally { await directory.close() }
  }

  async readOutput(operationId: string) {
    let file: Awaited<ReturnType<typeof open>>
    try { file = await open(`${this.path(operationId)}.output`, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const record = await file.stat()
      if (!record.isFile() || record.nlink !== 1 || record.mode & 0o077 || record.uid !== process.getuid?.()
        || record.size > 4 * 1024 * 1024) throw new Error('Unsafe workflow recovery output')
      return RemoteWorkflowPhysicalOutputSchema.parse(JSON.parse(await file.readFile('utf8')))
    } finally { await file.close() }
  }

  remember(raw: InstalledWorkflowRecoveryCapture) {
    const capture = CaptureSchema.parse(raw)
    const previous = readRecord(this.path(capture.intent.operationId))
    if (previous !== undefined) {
      if (!isDeepStrictEqual(CaptureSchema.parse(previous), capture)) {
        throw new Error('Original workflow recovery capture changed')
      }
      return
    }
    writeRecord(this.path(capture.intent.operationId), capture, true)
  }

  read(receipt: RemoteOperationReceipt) {
    const raw = readRecord(this.path(receipt.intent.operationId))
    if (raw === undefined) return undefined
    const capture = CaptureSchema.parse(raw)
    const originalIntent = { ...receipt.intent, owner: capture.intent.owner }
    if (!isDeepStrictEqual(capture.intent, originalIntent)
      || !isDeepStrictEqual(capture.connection, receipt.connection)
      || receipt.native && (capture.session.nativeSessionId !== receipt.native.sessionId
        || capture.native.processIdentityDigest !== receipt.native.processIdentityDigest)
      || !receipt.entryAttempted) {
      throw new Error('Original workflow recovery capture changed')
    }
    return capture
  }

  async reconcile(receipt: RemoteOperationReceipt, journal: RemoteOperationJournal, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!receipt.native) throw new Error('Original native ownership is unavailable')
    const capture = this.read(receipt)
    const launches = [...this.registry.snapshot().launches]
    if (capture && !launches.some(row => row.launchId === capture.launch.launchId)) {
      const archived = this.registry.closedRegistration(capture.launch.owner, capture.launch.launchId)
      if (archived) launches.push(archived)
    }
    const candidates = launches.filter(row => row.owner === `execution:${receipt.intent.executionId}`
      && remoteWorkflowProcessDigest(receipt.connection, capture?.intent ?? receipt.intent, row)
        === receipt.native!.processIdentityDigest)
    if (candidates.length !== 1) throw new Error('Original native registry owner is missing or ambiguous')
    const observed = candidates[0]!
    const original = RemoteNativeLaunchObservationSchema.parse({
      owner: observed.owner, launchId: observed.launchId, bootId: observed.bootId,
      guardian: observed.guardian, provider: observed.provider, boundary: observed.boundary, lifecycle: 'active',
    })
    await this.registry.closeRegistration(this.registry.scope(original.owner), original.launchId, signal)
    if (!await this.registry.closeOwner(original.owner, signal)) throw new Error('Original native closure is unconfirmed')
    const closed = this.registry.closedRegistration(original.owner, original.launchId)
    if (!closed || closed.lifecycle !== 'closed' || !closed.closureEvidence) {
      throw new Error('Original native closure evidence is missing')
    }
    if (!receipt.terminal) {
      await journal.revokeFence(receipt.intent.operationId)
      await journal.terminal(receipt.intent.operationId, {
        kind: 'cancelled',
        closureEvidenceDigest: commandInputHash({ intent: receipt.intent, native: receipt.native,
          launch: original, physicalOwnerClosed: true }).slice('sha256:'.length),
      })
    }
    return { capture, original, closed }
  }
}
