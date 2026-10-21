import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { WorkerConversationRegisteredCopySchema,
  type WorkerConversationFileAction, type WorkerConversationFileCopy } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { PreparedCodexFileTurn } from '../harnesses/codexFiles/runtime.js'
import type { CodexFileHostLease } from '../harnesses/codexFiles/port.js'
import { collectCodexFileBytes } from '../harnesses/codexFiles/bytes.js'
import { DomainError } from '../errors.js'
import { retryDeviceRequest } from '../devices/deviceRequestRetry.js'
import { reportOperationProgress } from '../operationProgress.js'

export type PrepareWorkerFiles = (input: { session: NativeSessionReference;
  clientCorrelationId: string; signal: AbortSignal; host: CodexFileHostLease;
  assertHost(): Promise<void> }) => Promise<PreparedCodexFileTurn | undefined>

/** The normal file turn and its private credential remain on Main. */
export class MainWorkerFiles {
  private turn: Promise<PreparedCodexFileTurn | undefined> | undefined
  private hostId: string | undefined
  private readonly pendingCopies = new Map<string, number>()
  private readonly signals = new AsyncLocalStorage<AbortSignal>()

  constructor(private readonly prepare: PrepareWorkerFiles,
    private readonly sendCopy: (copy: WorkerConversationFileCopy, signal: AbortSignal) => Promise<unknown>) {}

  authorizes(copy: WorkerConversationFileCopy): boolean {
    return (this.pendingCopies.get(commandInputHash(copy)) ?? 0) > 0
  }

  private async copy(copy: WorkerConversationFileCopy, signal: AbortSignal) {
    const key = commandInputHash(copy)
    this.pendingCopies.set(key, (this.pendingCopies.get(key) ?? 0) + 1)
    try {
      // Begin, immutable chunks and finish already acknowledge duplicate frames on the Worker.
      const result = await retryDeviceRequest(() => this.sendCopy(copy, signal), { retry: 'idempotent', signal })
      if (copy.phase === 'chunk') reportOperationProgress(Buffer.byteLength(copy.contentBase64, 'base64'))
      return result
    }
    finally {
      const remaining = this.pendingCopies.get(key)! - 1
      if (remaining) this.pendingCopies.set(key, remaining)
      else this.pendingCopies.delete(key)
    }
  }

  private host(executionHostId: string): CodexFileHostLease {
    const signal = () => {
      const value = this.signals.getStore()
      if (!value) throw new Error('Worker file operation has no current request')
      return value
    }
    return {
      executionHostId, pathStyle: 'posix',
      materialize: async input => {
        if (input.writable) throw new DomainError('WORKER_FILE_WRITE_DENIED', 'Mutable host paths are unavailable.', 403)
        const bytes = await collectCodexFileBytes(input.bytes, MAX_FILE_BYTES, signal())
        const transferId = randomUUID()
        await this.copy({ phase: 'begin', transferId, executionHostId, filename: input.filename,
          mediaType: input.mediaType, byteSize: input.byteSize, sha256: input.sha256 }, signal())
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          await this.copy({ phase: 'chunk', transferId, executionHostId, offset,
            contentBase64: bytes.subarray(offset, offset + 65536).toString('base64') }, signal())
        }
        return WorkerConversationRegisteredCopySchema.parse(
          await this.copy({ phase: 'finish', transferId, executionHostId }, signal()))
      },
      async sealCompleted() { throw new DomainError('WORKER_FILE_WRITE_DENIED', 'Mutable host paths are unavailable.', 403) },
      close: async () => { await this.copy({ phase: 'close', executionHostId }, signal()) },
    }
  }

  handle(action: WorkerConversationFileAction, input: {
    session: NativeSessionReference; clientCorrelationId: string; signal: AbortSignal;
    nativeTurnId?: string | undefined;
  }): Promise<unknown> {
    return this.signals.run(input.signal, () => this.apply(action, input))
  }

  private async apply(action: WorkerConversationFileAction, input: {
    session: NativeSessionReference; clientCorrelationId: string; signal: AbortSignal;
    nativeTurnId?: string | undefined;
  }): Promise<unknown> {
    if (action.phase === 'prepare') {
      if (this.hostId && this.hostId !== action.executionHostId) {
        throw new DomainError('WORKER_FILE_OWNER_CHANGED', 'The attachment host changed.', 409)
      }
      this.hostId = action.executionHostId
      this.turn ??= this.prepare({ ...input, host: this.host(this.hostId),
        assertHost: async () => {
          z.object({ acknowledged: z.literal(true) }).strict().parse(
            await this.copy({ phase: 'validate', executionHostId: this.hostId! }, input.signal))
        } })
      const turn = await this.turn
      return turn ? { allowedTools: turn.allowedTools() } : null
    }
    const turn = await this.turn
    if (!turn) throw new DomainError('WORKER_FILE_TURN_UNAVAILABLE', 'The admitted file turn is unavailable.', 409)
    switch (action.phase) {
      case 'input': return turn.nativeInput(action.prompt)
      case 'activate':
        if (input.nativeTurnId !== action.nativeTurnId) {
          throw new DomainError('WORKER_FILE_TURN_UNAVAILABLE', 'Native submission has not been persisted.', 409)
        }
        await turn.activate(action.nativeTurnId)
        return { acknowledged: true }
      case 'call':
        if (input.nativeTurnId !== action.call.turnId || input.session.nativeSessionId !== action.call.threadId) {
          throw new DomainError('WORKER_FILE_TURN_UNAVAILABLE', 'The tool call belongs to another native turn.', 409)
        }
        {
          const { namespace, ...call } = action.call
          return turn.call({ ...call, ...(namespace !== undefined ? { namespace } : {}) })
        }
      case 'publications': return turn.publications()
      case 'close':
        await turn.close()
        return { acknowledged: true }
    }
  }
}
