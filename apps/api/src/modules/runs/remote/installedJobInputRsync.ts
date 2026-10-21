import { constants } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { JobInputAdmissionSchema, JobInputDeliveryReceiptSchema, type JobInputAdmission } from '@foreman-code/contracts/job-inputs'
import {
  TransferIntentSchema,
  VerifiedTransferReceiptSchema,
  BYTE_TRANSFER_POLICY,
  type TransferIntent,
  type TransferContext,
} from '@foreman-code/contracts/byte-transfer'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { JobSourcePort } from '../../jobs/executor.js'
import type { JobInputWorkerChannel } from '../../files/jobInputs/channel.js'
import { ReadonlyJobInputDelivery, type JobInputDeliverySource, type JobSystemInput } from '../../files/jobInputs/delivery.js'
import { recipient, inputHash, snapshotDigest, manifestBytes, verificationContextPin } from '../../files/jobInputs/manifest.js'
import { JOB_INPUT_NAMESPACE } from '../../files/jobInputs/protocol.js'
import { byteRange } from '../../files/tools/transfers.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import { privateDirectory } from '../../harnesses/recovery/storage.js'
import { anchored, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { requireJobGitMounts, verifyJobGitMounts } from '../../jobs/privateGitMounts.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { DomainError } from '../../errors.js'

type VerifiedSource = Awaited<ReturnType<JobSourcePort['verify']>>
interface RetainedInput { operationId: string; admission: JobInputAdmission; source: VerifiedSource }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const recordLimit = 2 * 1024 * 1024 // original admission plus verified-source metadata; no transfer bytes

/** Durable original admission is separate from detached delivery and never serves bytes.
 * The shared canonical receiver remains the sole staging/quota authority. */
export function createInstalledJobInputRsync(input: {
  receiver: ResumableByteTransferService; journal: RemoteOperationJournal; channel: JobInputWorkerChannel
  receiptRoot: string; admissionRoot: string; systemInput?: JobSystemInput
}) {
  const lifetime = new AbortController(), active = new Set<Promise<unknown>>()
  const context = () => transferContextForBinding(input.channel.currentBinding())
  const fileName = (execution: JobExecutionRecord) => `${inputHash([recipient(execution), snapshotDigest(execution)])}.json`
  const readRecord = async (directory: FileHandle, name: string): Promise<RetainedInput> => {
    const file = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > recordLimit) throw new Error('Original Job input admission record changed')
      const raw = JSON.parse(await file.readFile('utf8')) as RetainedInput
      const admission = JobInputAdmissionSchema.parse(raw.admission)
      if (typeof raw.operationId !== 'string' || !raw.source || typeof raw.source !== 'object' || raw.source.privateGit !== true
        || typeof raw.source.privateRepositoryRoot !== 'string' || typeof raw.source.directoryIdentityHash !== 'string'
        || !Number.isFinite(raw.source.diskQuotaBytes) || raw.source.diskQuotaBytes <= 0) throw new Error('Original Job input admission unavailable')
      return { operationId: raw.operationId, admission, source: raw.source }
    } finally { await file.close() }
  }
  const records = async () => {
    let directory: FileHandle
    try { directory = await openPrivateRoot(input.admissionRoot) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    try {
      const names = await readdir(anchored(directory))
      if (names.length > BYTE_TRANSFER_POLICY.maxRecords) throw new Error('Job input admission inventory exceeds policy')
      const result: RetainedInput[] = []
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Unknown original Job input admission record')
        const record = await readRecord(directory, name)
        if (name !== `${record.admission.manifest.bindingId}.json`) throw new Error('Original Job input admission identity changed')
        result.push(record)
      }
      return result
    } finally { await directory.close() }
  }
  const retained = async (execution: JobExecutionRecord) => {
    const directory = await openPrivateRoot(input.admissionRoot)
    try {
      const record = await readRecord(directory, fileName(execution))
      if (record.operationId !== execution.operationId || !isDeepStrictEqual(record.admission.manifest.recipient, recipient(execution))
        || record.admission.manifest.inputSnapshotDigest !== snapshotDigest(execution)) throw new Error('Original Job input recipient changed')
      return record
    } finally { await directory.close() }
  }
  const executionFor = async (record: RetainedInput) => {
    const status = await input.journal.jobStatus(record.operationId)
    if (status.status !== 'known' || !isDeepStrictEqual(recipient(status.receipt.execution), record.admission.manifest.recipient)) throw new Error('Original Job input journal owner unavailable')
    return status.receipt.execution
  }
  const validateAdmission = (execution: JobExecutionRecord, admission: JobInputAdmission) => {
    const manifest = admission.manifest
    if (!isDeepStrictEqual(manifest.recipient, recipient(execution)) || manifest.bindingId !== fileName(execution).slice(0, -5)
      || manifest.inputSnapshotDigest !== snapshotDigest(execution) || hash(manifestBytes(manifest)) !== manifest.manifestSha256) throw new Error('Original canonical Job input admission changed')
    const expected = [{ relativePath: 'manifest.json', sha256: manifest.manifestSha256, byteSize: manifest.manifestByteSize },
      { relativePath: 'workflow-input.json', sha256: hash(Buffer.from(JSON.stringify(manifest.workflowInput))), byteSize: Buffer.byteLength(JSON.stringify(manifest.workflowInput)) },
      ...manifest.entries.map(entry => ({ relativePath: entry.relativePath, sha256: entry.pin.sha256, byteSize: entry.pin.byteSize })),
      ...(verificationContextPin(manifest) ? [verificationContextPin(manifest)!] : [])]
    if (admission.transfers.length !== expected.length || new Set(admission.transfers.map(item => item.intent.transferId)).size !== expected.length) throw new Error('Original Job input transfer inventory incomplete')
    for (const pin of expected) {
      const matches = admission.transfers.filter(item => item.relativePath === pin.relativePath)
      const intent = matches.length === 1 ? matches[0]!.intent : undefined
      if (!intent || intent.executionId !== execution.id || intent.attemptId !== execution.attemptId || intent.placementHash !== execution.acceptedSpec.bindingHash
        || intent.direction !== 'to-worker' || intent.byteClass !== 'artifact' || intent.sha256 !== pin.sha256 || intent.byteSize !== pin.byteSize
        || intent.manifestDigest !== manifest.manifestSha256) throw new Error('Original Job input transfer pin changed')
    }
  }
  const recheck = async (execution: JobExecutionRecord, admission: JobInputAdmission, signal: AbortSignal) => {
    signal.throwIfAborted(); validateAdmission(execution, admission)
    const record = await retained(execution), actual = await executionFor(record)
    if (!isDeepStrictEqual(actual, execution) || !isDeepStrictEqual(record.admission, admission)) throw new Error('Original Job input execution changed')
    for (const item of admission.transfers) {
      const binding = context()
      const reply = await input.channel.request(JOB_INPUT_NAMESPACE, { method: 'authorize', executionId: execution.id, transferId: item.intent.transferId }, { signal })
      const response = reply.payload as { authorized?: boolean; transferId?: string; bindingId?: string }
      signal.throwIfAborted()
      if (reply.bytes !== undefined || !isDeepStrictEqual(context(), binding) || response.authorized !== true || response.transferId !== item.intent.transferId
        || response.bindingId !== admission.manifest.bindingId) throw new Error('Original Job input authority unavailable')
      const verified = await input.receiver.resolveVerifiedReceipt(item.intent.transferId, binding)
      if (!isDeepStrictEqual(verified.intent, item.intent)) throw new Error('Original Job input verified receipt changed')
    }
    signal.throwIfAborted()
  }
  const preparations = new Map<string, { execution: JobExecutionRecord; source: VerifiedSource }>()
  const source: JobInputDeliverySource = {
    async admit(execution, signal, verificationContext) {
      signal.throwIfAborted()
      const preparing = preparations.get(execution.operationId)
      if (!preparing || !isDeepStrictEqual(preparing.execution, execution)) throw new Error('Original Job input preparation context missing')
      const binding = context(), reply = await input.channel.request(JOB_INPUT_NAMESPACE, {
        method: 'bind', recipient: recipient(execution), ...(verificationContext ? { verificationContext } : {}),
      }, { signal })
      if (reply.bytes !== undefined || !isDeepStrictEqual(context(), binding)) throw new Error('Original Job input binding changed')
      const admission = JobInputAdmissionSchema.parse(reply.payload); validateAdmission(execution, admission)
      if (!isDeepStrictEqual(admission.manifest.verificationContext, verificationContext)) {
        throw new Error('Canonical verification context differs from the protected worker input')
      }
      const original: RetainedInput = { operationId: execution.operationId, admission, source: structuredClone(preparing.source) }
      const status = await input.journal.jobStatus(execution.operationId)
      if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.execution, execution)) throw new Error('Original Job input journal owner changed')
      privateDirectory(input.admissionRoot)
      const directory = await openPrivateRoot(input.admissionRoot)
      try {
        const name = fileName(execution), bytes = Buffer.from(JSON.stringify(original))
        if (bytes.length > recordLimit) throw new Error('Original Job input admission exceeds its metadata budget')
        let file: FileHandle | undefined
        try {
          file = await open(anchored(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          await file.writeFile(bytes); await file.sync(); await directory.sync()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (!isDeepStrictEqual(await readRecord(directory, name), original)) throw new Error('Original Job input admission conflicts with retained facts', { cause: error })
        } finally { await file?.close() }
      } finally { await directory.close() }
      // Admission is durable before Main/Worker staging and quota allocation.
      for (const item of admission.transfers) {
        signal.throwIfAborted()
        await input.receiver.start(item.intent, context())
        const progress = await input.receiver.status(item.intent.transferId, context())
        if (progress.state !== 'verified') {
          const timeoutMs = Math.min(BYTE_TRANSFER_POLICY.maxIdleMs, Date.parse(item.intent.expiresAt) - Date.now())
          if (timeoutMs <= 0) throw new DomainError('JOB_INPUT_TRANSFER_EXPIRED', 'The original input transfer has expired.', 409)
          const staged = await input.channel.request(JOB_INPUT_NAMESPACE,
            { method: 'stage', transferId: item.intent.transferId }, { signal, timeoutMs })
          if (staged.bytes !== undefined) throw new Error('Job input stage returned unexpected bytes')
          const receipt = VerifiedTransferReceiptSchema.parse(staged.payload)
          if (!isDeepStrictEqual(receipt.intent, item.intent)) throw new Error('Original Job input stage receipt changed')
        }
        const receipt = await input.receiver.resolveVerifiedReceipt(item.intent.transferId, context())
        if (!isDeepStrictEqual(receipt.intent, item.intent)) throw new Error('Original Job input canonical receipt changed')
      }
      await recheck(execution, admission, signal); return admission
    },
    async accepted(execution, signal) { const record = await retained(execution); await recheck(execution, record.admission, signal); return record.admission },
    recheck,
    async read(execution, admission, path, offset, length, signal) {
      await recheck(execution, admission, signal)
      const item = admission.transfers.find(value => value.relativePath === path)
      if (!item) throw new Error('Original Job input path unavailable')
      const receipt = await input.receiver.resolveVerifiedReceipt(item.intent.transferId, context())
      return byteRange(await input.receiver.openVerified(receipt, context()), offset, length)
    },
  }
  const delivery = new ReadonlyJobInputDelivery(source, input.receiptRoot, input.systemInput)
  const find = async (id: string) => {
    const matches = (await records()).filter(record => record.admission.transfers.some(item => item.intent.transferId === id))
    if (matches.length !== 1) throw new Error('Unique original Job input admission unavailable')
    return matches[0]!
  }
  return {
    async owns(intent: TransferIntent) { return (await records()).some(record => record.admission.transfers.some(item => item.intent.transferId === intent.transferId)) },
    async acknowledged(raw: TransferIntent, actualContext: TransferContext) {
      const intent = TransferIntentSchema.parse(raw), record = await find(intent.transferId), execution = await executionFor(record)
      const accepted = record.admission.transfers.find(item => item.intent.transferId === intent.transferId)!
      if (!isDeepStrictEqual(intent, accepted.intent) || !isDeepStrictEqual(context(), actualContext)) throw new Error('Original Job input ACK context changed')
      const signal = AbortSignal.any([AbortSignal.timeout(5000), lifetime.signal])
      const reply = await input.channel.request(JOB_INPUT_NAMESPACE, { method: 'delivery-status', transferId: intent.transferId }, { signal })
      if (reply.bytes !== undefined || !isDeepStrictEqual(context(), actualContext)) throw new Error('Original Job input delivery status changed')
      requireJobGitMounts(execution, record.source); await verifyJobGitMounts(execution, record.source)
      await delivery.verifyPrepared(execution, record.source, JobInputDeliveryReceiptSchema.parse(reply.payload), signal)
      if (!isDeepStrictEqual(context(), actualContext)) throw new Error('Original Job input ACK binding changed')
    },
    prepare(execution: JobExecutionRecord, verified: VerifiedSource, signal: AbortSignal) {
      signal = AbortSignal.any([signal, lifetime.signal]); signal.throwIfAborted()
      if (preparations.has(execution.operationId)) throw new DomainError('JOB_INPUT_BUSY', 'Original Job input delivery is already preparing.', 409)
      requireJobGitMounts(execution, verified)
      preparations.set(execution.operationId, { execution: structuredClone(execution), source: structuredClone(verified) })
      const task = (async () => { try {
        const receipt = await delivery.prepare(execution, verified, signal)
        await delivery.verifyPrepared(execution, verified, receipt, signal)
        const record = await retained(execution)
        for (const item of record.admission.transfers) {
          const reply = await input.channel.request(JOB_INPUT_NAMESPACE, { method: 'delivery-ack', transferId: item.intent.transferId, receipt }, { signal })
          if (reply.bytes !== undefined || !isDeepStrictEqual(JobInputDeliveryReceiptSchema.parse(reply.payload), receipt)) throw new Error('Original Job input delivery ACK differs')
        }
        await recheck(execution, record.admission, signal); return receipt
      } finally { preparations.delete(execution.operationId) } })()
      active.add(task)
      void task.then(() => active.delete(task), () => active.delete(task))
      return task
    },
    verifyPrepared: delivery.verifyPrepared.bind(delivery),
    async close() {
      lifetime.abort(new Error('Installed Job input delivery closed'))
      const failures: unknown[] = []
      while (active.size) {
        for (const result of await Promise.allSettled([...active])) if (result.status === 'rejected' && result.reason !== lifetime.signal.reason) failures.push(result.reason)
      }
      if (failures.length) throw new AggregateError(failures, 'Original Job input delivery IO closure remains incomplete')
      // The installed domain owns and closes the one shared canonical receiver.
    },
  }
}
