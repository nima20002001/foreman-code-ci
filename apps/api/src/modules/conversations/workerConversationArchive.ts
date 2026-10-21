import { readFile, readdir, stat } from 'node:fs/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationReceiptSchema, workerConversationGeneration,
  type WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'

const ArchiveEntrySchema = z.object({ receipt: WorkerConversationReceiptSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()
const ArchiveSchema = ArchiveEntrySchema.extend({ generations: z.array(ArchiveEntrySchema).optional() })

/** Closed receipts retain all replay identities outside the bounded recovery snapshot. */
export class WorkerConversationArchive {
  private previewPaths?: Promise<Map<string, string[]>>
  constructor(private readonly path: string, private readonly byteLimit: number,
    private readonly write: (path: string, value: string) => Promise<void>) {}

  private recordPath(conversationId: string) {
    return `${this.path}.conversations/${commandInputHash(conversationId)}.json`
  }

  private generationDirectory(conversationId: string) {
    return `${this.path}.conversations/${commandInputHash(conversationId)}`
  }

  private generationPath(conversationId: string, generation?: string) {
    return `${this.generationDirectory(conversationId)}/${commandInputHash(generation ?? null)}.json`
  }

  async read(conversationId: string, generation?: string): Promise<WorkerConversationReceipt | undefined> {
    const path = this.generationPath(conversationId, generation)
    const records = await this.readFile(path, conversationId)
    if (records.length) return this.generationRecord(path, conversationId, records)
    const combined = (await this.readFile(this.recordPath(conversationId), conversationId))
      .find(record => workerConversationGeneration(record.binding) === generation)
    if (combined || !generation) return combined
    const key = commandInputHash([conversationId, generation])
    const preview = await this.readFile(this.recordPath(key), conversationId)
    if (preview.length && (preview.length !== 1 || preview[0]!.binding.sessionGeneration !== generation)) {
      throw new Error('Conversation archive changed: recovery required')
    }
    return preview[0]
  }

  async readAll(conversationId: string): Promise<WorkerConversationReceipt[]> {
    // Existing combined archives remain readable; subsequent saves use separate generation files.
    const preview: WorkerConversationReceipt[] = []
    for (const path of (await this.readPreviewPaths()).get(conversationId) ?? []) {
      preview.push(...await this.readFile(path, conversationId))
    }
    const records = new Map([...preview, ...await this.readFile(this.recordPath(conversationId), conversationId)]
      .map(record => [workerConversationGeneration(record.binding), record]))
    const directory = this.generationDirectory(conversationId)
    let names: string[]
    try { names = await readdir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...records.values()]
      throw error
    }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const path = `${directory}/${name}`
      const record = this.generationRecord(path, conversationId, await this.readFile(path, conversationId))
      records.set(workerConversationGeneration(record.binding), record)
    }
    return [...records.values()]
  }

  private readPreviewPaths(): Promise<Map<string, string[]>> {
    // Preview archives are immutable and new saves never use their flat generation keys.
    // Index them once, rather than scanning other conversations on every journal change.
    return this.previewPaths ??= (async () => {
      const directory = `${this.path}.conversations`
      let names: string[]
      try { names = await readdir(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
        throw error
      }
      const paths = new Map<string, string[]>()
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const path = `${directory}/${name}`
        for (const record of await this.readFile(path)) {
          if (!record.binding.sessionGeneration) continue
          const id = record.binding.owner.conversationId
          const key = commandInputHash([id, record.binding.sessionGeneration])
          if (path !== this.recordPath(key) && path !== this.recordPath(id)) {
            throw new Error('Conversation archive changed: recovery required')
          }
          const previous = paths.get(id) ?? []
          if (!previous.includes(path)) previous.push(path)
          paths.set(id, previous)
        }
      }
      return paths
    })()
  }

  private generationRecord(path: string, conversationId: string, records: WorkerConversationReceipt[]) {
    const record = records[0]
    if (records.length !== 1 || !record || this.generationPath(conversationId, workerConversationGeneration(record.binding)) !== path) {
      throw new Error('Conversation archive changed: recovery required')
    }
    return record
  }

  private async readFile(path: string, conversationId?: string): Promise<WorkerConversationReceipt[]> {
    let serialized: string
    try {
      if ((await stat(path)).size > this.byteLimit + 1024) throw new Error('Conversation archive byte limit reached')
      serialized = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const archive = ArchiveSchema.parse(JSON.parse(serialized))
    conversationId ??= archive.receipt.binding.owner.conversationId
    const entries = [archive, ...(archive.generations ?? [])]
    const generations = new Set<string | undefined>()
    for (const entry of entries) {
      if (!entry.receipt.closed || entry.receipt.binding.owner.conversationId !== conversationId
        || commandInputHash(entry.receipt) !== entry.digest || generations.has(workerConversationGeneration(entry.receipt.binding))) {
        throw new Error('Conversation archive changed: recovery required')
      }
      generations.add(workerConversationGeneration(entry.receipt.binding))
    }
    return entries.map(entry => entry.receipt)
  }

  async save(receipt: WorkerConversationReceipt) {
    const record = WorkerConversationReceiptSchema.parse(receipt)
    if (!record.closed) throw new Error('Positive conversation closure required')
    const serialized = JSON.stringify({ receipt: record, digest: commandInputHash(record) })
    if (Buffer.byteLength(serialized) > this.byteLimit + 1024) throw new Error('Conversation archive byte limit reached')
    await this.write(this.generationPath(record.binding.owner.conversationId, workerConversationGeneration(record.binding)), serialized)
  }
}
