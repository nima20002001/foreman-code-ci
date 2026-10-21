import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import {
  WorkerConversationFileCopySchema, WorkerConversationFilePreparationSchema, WorkerConversationFileInputSchema,
  WorkerConversationFileResultSchema, WorkerConversationFilePublicationsSchema,
  type WorkerConversationRpcRequest,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { CodexChatFiles } from '../harnesses/codexFiles/runtime.js'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { CodexFileHostLease, RegisteredCodexCopy } from '../harnesses/codexFiles/port.js'
import { DomainError } from '../errors.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'

interface Transfer {
  input: Extract<z.infer<typeof WorkerConversationFileCopySchema>, { phase: 'begin' }>
  chunks: Buffer[]
  length: number
  result?: RegisteredCodexCopy
  finishing?: Promise<RegisteredCodexCopy>
}
interface Delivery {
  source: WorkerConversationRpcRequest
  session: NativeSessionReference
  correlationId: string
  nativeTurnId?: string
  host: CodexFileHostLease
  createHost(): Promise<CodexFileHostLease>
  priorHosts: CodexFileHostLease[]
  hostClosed: boolean
  allowedTools: readonly string[]
  assertCurrent(signal: AbortSignal): Promise<void>
  transfers: Map<string, Transfer>
  closed: boolean
}

/** Owns attachment copies in the native worker filesystem, using execution-v1. */
export class WorkerConversationFiles {
  private readonly deliveries = new Map<string, Delivery>()

  constructor(private readonly callbacks: Pick<ReturnType<typeof workerConversationCallbacks>, 'files' | 'authorizeCopy'>) {}

  adapter(input: {
    source(): WorkerConversationRpcRequest
    host(): Promise<CodexFileHostLease>
    assertCurrent(signal: AbortSignal): Promise<void>
    signal: AbortSignal
  }): CodexChatFiles {
    return { prepare: async turn => {
      const source = input.source()
      const missingFileInputs = source.binding.appMcpAccess === 'scoped'
        && !(source.method === 'conversation.start-turn' && source.fileInputs)
      if (!source.admissionId || source.binding.harness !== 'codex' || missingFileInputs
        || !['conversation.initial-turn', 'conversation.start-turn'].includes(source.method)
        || !('correlationId' in source) || source.correlationId !== turn.clientCorrelationId
        || this.deliveries.has(source.admissionId)) this.denied()
      await input.assertCurrent(turn.signal)
      const host = await input.host()
      const delivery: Delivery = { source, session: turn.session, correlationId: turn.clientCorrelationId,
        host, createHost: input.host, priorHosts: [], hostClosed: false, allowedTools: [],
        assertCurrent: input.assertCurrent, transfers: new Map(), closed: false }
      this.deliveries.set(source.admissionId, delivery)
      const call = (action: Parameters<typeof this.callbacks.files>[3], signal = input.signal) => {
        return this.callbacks.files(delivery.source, turn.session, turn.clientCorrelationId, action, signal)
      }
      try {
        const raw = await call({ phase: 'prepare', executionHostId: host.executionHostId }, turn.signal)
        if (raw === null) {
          await host.close()
          delivery.closed = true
          return undefined
        }
        const prepared = WorkerConversationFilePreparationSchema.parse(raw)
        delivery.allowedTools = prepared.allowedTools
        return {
          allowedTools: () => prepared.allowedTools,
          nativeInput: async prompt => WorkerConversationFileInputSchema.parse(await call({ phase: 'input', prompt })),
          activate: async nativeTurnId => {
            z.object({ acknowledged: z.literal(true) }).strict().parse(await call({ phase: 'activate', nativeTurnId }))
            delivery.nativeTurnId = nativeTurnId
          },
          call: async request => WorkerConversationFileResultSchema.parse(await call({ phase: 'call', call: request })),
          publications: async () => WorkerConversationFilePublicationsSchema.parse(await call({ phase: 'publications' })),
          close: async () => {
            z.object({ acknowledged: z.literal(true) }).strict().parse(await call({ phase: 'close' }))
            for (const old of delivery.priorHosts) await old.close()
            delivery.closed = true
          },
        }
      } catch (error) {
        await host.close()
        delivery.closed = true
        throw error
      }
    } }
  }

  async recover(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
    nativeTurnId: string, signal: AbortSignal) {
    const candidates = [...this.deliveries.values()].filter(delivery => !delivery.closed
      && isDeepStrictEqual(delivery.source.binding, request.binding)
      && isDeepStrictEqual(delivery.session, request.session) && delivery.correlationId === request.correlationId)
    if (!candidates.length) return
    if (candidates.length !== 1 || !request.admissionId || request.method !== 'conversation.reconcile') this.denied()
    const delivery = candidates[0]!
    if (delivery.nativeTurnId !== nativeTurnId) this.denied()
    await delivery.assertCurrent(signal)
    if (delivery.source.admissionId === request.admissionId) return
    const previous = { host: delivery.host, transfers: delivery.transfers, hostClosed: delivery.hostClosed }
    const replacement = await delivery.createHost()
    delivery.host = replacement
    delivery.hostClosed = false
    delivery.transfers = new Map()
    this.deliveries.set(request.admissionId, delivery)
    try {
      const prepared = WorkerConversationFilePreparationSchema.parse(await this.callbacks.files(request,
        delivery.session, delivery.correlationId,
        { phase: 'prepare', executionHostId: replacement.executionHostId }, signal))
      if (!isDeepStrictEqual(prepared.allowedTools, delivery.allowedTools)) this.denied()
      z.object({ acknowledged: z.literal(true) }).strict().parse(await this.callbacks.files(request,
        delivery.session, delivery.correlationId, { phase: 'activate', nativeTurnId }, signal))
      delivery.priorHosts.push(previous.host)
      delivery.source = request
    } catch (error) {
      await replacement.close()
      Object.assign(delivery, previous)
      this.deliveries.delete(request.admissionId)
      throw error
    }
    for (const [id, value] of this.deliveries) {
      if (value === delivery && id !== request.admissionId) this.deliveries.delete(id)
    }
  }

  private denied(): never {
    throw new DomainError('WORKER_FILE_OWNER_UNAVAILABLE', 'The admitted worker attachment host is unavailable.', 409)
  }

  async copy(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.file-copy' }>, signal: AbortSignal) {
    const delivery = this.deliveries.get(request.admissionId)
    if (!delivery || request.copy.executionHostId !== delivery.host.executionHostId
      || request.binding.owner.conversationId !== delivery.source.binding.owner.conversationId) this.denied()
    await this.callbacks.authorizeCopy(request, request.copy, signal)
    await delivery.assertCurrent(signal)
    const copy = request.copy
    if (copy.phase === 'close') {
      await delivery.host.close()
      delivery.hostClosed = true
      delivery.transfers.clear()
      return { acknowledged: true }
    }
    if (delivery.closed || delivery.hostClosed) this.denied()
    if (copy.phase === 'validate') return { acknowledged: true }
    if (copy.phase === 'begin') {
      const previous = delivery.transfers.get(copy.transferId)
      if (previous) {
        if (!isDeepStrictEqual(previous.input, copy)) this.denied()
      } else {
        if (delivery.transfers.size >= MAX_MESSAGE_ATTACHMENTS * 2) this.denied()
        delivery.transfers.set(copy.transferId, { input: copy, chunks: [], length: 0 })
      }
      return { acknowledged: true }
    }
    const transfer = delivery.transfers.get(copy.transferId)
    if (!transfer) this.denied()
    if (copy.phase === 'chunk') {
      const bytes = Buffer.from(copy.contentBase64, 'base64')
      if (transfer.result || bytes.toString('base64') !== copy.contentBase64 || bytes.length > 65536
        || transfer.finishing) this.denied()
      if (copy.offset < transfer.length) {
        const received = Buffer.concat(transfer.chunks)
        if (copy.offset + bytes.length > transfer.length
          || !received.subarray(copy.offset, copy.offset + bytes.length).equals(bytes)) this.denied()
        return { acknowledged: true }
      }
      if (copy.offset !== transfer.length || transfer.length + bytes.length > transfer.input.byteSize) this.denied()
      transfer.chunks.push(bytes)
      transfer.length += bytes.length
      return { acknowledged: true }
    }
    if (transfer.result) return transfer.result
    if (transfer.length !== transfer.input.byteSize) this.denied()
    transfer.finishing ??= delivery.host.materialize({ ...transfer.input, writable: false,
      bytes: Readable.from(transfer.chunks) })
    transfer.result = await transfer.finishing
    transfer.chunks = []
    signal.throwIfAborted()
    return transfer.result
  }

  async closeConversation(conversationId: string) {
    for (const [id, delivery] of this.deliveries) {
      if (delivery.source.binding.owner.conversationId !== conversationId) continue
      await delivery.host.close()
      for (const host of delivery.priorHosts) await host.close()
      this.deliveries.delete(id)
    }
  }

  async close() {
    for (const delivery of this.deliveries.values()) {
      await delivery.host.close()
      for (const host of delivery.priorHosts) await host.close()
    }
    this.deliveries.clear()
  }
}
