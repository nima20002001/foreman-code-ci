import { createHash } from 'node:crypto'
import { opendir, readFile } from 'node:fs/promises'
import { z } from 'zod'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteJobOperationReceiptRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { QualificationReceiptSchema } from '../../jobs/qualificationJournal.js'
import { JobNativeOwnerSchema } from '../../jobs/executorJournal.js'
import { SourcePreparationClosureSchema } from '@foreman-code/contracts/source-admission'

const ArchiveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow'), receipt: RemoteOperationReceiptSchema }).strict(),
  z.object({ kind: z.literal('job'), receipt: RemoteJobOperationReceiptRecordSchema,
    owner: JobNativeOwnerSchema.nullable(), logs: z.unknown(), outputs: z.array(z.unknown()),
    sourceClosure: SourcePreparationClosureSchema.nullable() }).strict(),
  z.object({ kind: z.literal('qualification'), receipt: QualificationReceiptSchema }).strict(),
])
const TombstoneSchema = z.object({ operationId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const RUNTIME_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Cold records and identity tombstones live outside the bounded recovery snapshot. */
export class RuntimeJournalArchive {
  constructor(private readonly path: string, private readonly write: (path: string, value: string) => Promise<void>) {}

  async read(identity: string): Promise<z.infer<typeof ArchiveSchema> | null> {
    let tombstone: z.infer<typeof TombstoneSchema>
    try {
      tombstone = TombstoneSchema.parse(JSON.parse(await readFile(`${this.path}.retired/${hash(identity)}.json`, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const serialized = await readFile(`${this.path}.runtime-archive/${hash(tombstone.operationId)}.json`, 'utf8')
    if (hash(serialized) !== tombstone.digest) throw new Error('Runtime archive changed: recovery required')
    const archive = ArchiveSchema.parse(JSON.parse(serialized))
    const operationId = archive.kind === 'qualification' ? archive.receipt.admission.operationId : archive.receipt.intent.operationId
    if (operationId !== tombstone.operationId) throw new Error('Runtime archive identity changed')
    return archive
  }

  async save(raw: z.infer<typeof ArchiveSchema>): Promise<void> {
    const archive = ArchiveSchema.parse(raw)
    const receipt = archive.receipt
    const identities = archive.kind !== 'qualification'
      ? [`operation:${archive.receipt.intent.operationId}`, `execution:${archive.receipt.intent.executionId}`,
        `attempt:${archive.receipt.intent.attemptId}`]
      : [`operation:${archive.receipt.admission.operationId}`, `approval:${archive.receipt.admission.approvalId}`,
        `lease:${archive.receipt.admission.leaseId}`]
    const operationId = 'intent' in receipt ? receipt.intent.operationId : receipt.admission.operationId
    const serialized = JSON.stringify(archive)
    await this.write(`${this.path}.runtime-archive/${hash(operationId)}.json`, serialized)
    const tombstone = JSON.stringify({ operationId, digest: hash(serialized) })
    for (const identity of identities) await this.write(`${this.path}.retired/${hash(identity)}.json`, tombstone)
    if (archive.kind === 'qualification') {
      await this.write(`${this.path}.qualifications/${hash(operationId)}.json`, JSON.stringify({ operationId }))
    }
  }

  async *qualifications(): AsyncGenerator<z.infer<typeof QualificationReceiptSchema>> {
    let directory: Awaited<ReturnType<typeof opendir>>
    try { directory = await opendir(`${this.path}.qualifications`) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Qualification archive index changed')
      const record = z.object({ operationId: z.string() }).strict().parse(JSON.parse(
        await readFile(`${this.path}.qualifications/${entry.name}`, 'utf8')))
      const archived = await this.read(`operation:${record.operationId}`)
      if (archived?.kind !== 'qualification') throw new Error('Qualification archive is unavailable')
      yield archived.receipt
    }
  }
}
