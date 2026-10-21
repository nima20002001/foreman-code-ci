import { Readable } from 'node:stream'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { FileRevisionSchema, type FileRevision, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { FileToolOperation } from '../../files/tools/types.js'
import { markdownReadText } from '../../files/tools/markdownReadText.js'
import { FILE_SESSION_LEASE_MS, FILE_SESSION_RENEWAL_WINDOW_MS } from '../../files/tools/context.js'
import { leaseFailureCause, renewOwnedLeases } from '../../leases/ownerLeases.js'
import { assertRegisteredCodexCopy, CodexFileDeliveryError, collectCodexFileBytes, fail, sha256 } from './bytes.js'
import { warnCodexFileError } from './errorLog.js'
import type {
  AcceptedCodexFileTurn, CodexAttachmentSource, CodexFileCall, CodexFileCallResult,
  CodexFileHostLease, CodexFileInput, CodexFileLimits, CodexFileServices,
  CodexImagePreparation, RegisteredCodexCopy,
} from './port.js'

/** Codex function names cannot contain dots. The underlying FIL-05 names do not change. */
export const CODEX_FILE_TOOL_ALIASES = Object.freeze({
  files_list: 'files.list',
  files_read: 'files.read',
  files_create_working_copy: 'files.create_working_copy',
  files_publish_result: 'files.publish_result',
  files_write_working_copy: 'files.write_working_copy',
  files_apply_format_edit: 'files.apply_format_edit',
} as const)
const mutation = (name: FileToolOperation) => name !== 'files.list' && name !== 'files.read'
const pins = (ref: MessageAttachmentRef): string => JSON.stringify([ref.fileId, ref.revisionId])
const sameScope = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)
const textResult = (value: unknown, extra?: string): CodexFileCallResult => ({ success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }, ...(extra ? [{ type: 'inputText' as const, text: extra }] : [])],
})
const refused = (reason?: string): CodexFileCallResult => ({ success: false,
  contentItems: [{ type: 'inputText', text: reason ?? 'File operation unavailable or denied.' }],
})
interface Delivery { ref: MessageAttachmentRef; revision: FileRevision; filename: string; copy: RegisteredCodexCopy; image?: RegisteredCodexCopy; firstFrameOnly: boolean }
interface WorkingCopy { copy?: RegisteredCodexCopy; writeId: string; completed: boolean; busy: boolean }

export interface CodexFileTurnDependencies {
  files: CodexFileServices
  source: CodexAttachmentSource
  host: CodexFileHostLease
  limits: CodexFileLimits
  prepareImage?: CodexImagePreparation
  /** Must parse and bind FIL-05 read results to the requested immutable range. */
  parseRead: (request: unknown, result: unknown) => Awaited<ReturnType<CodexFileServices['read']>>
  /** Frozen strict input validation MUST precede sealing or any runner mutation. */
  parseCall: (tool: FileToolOperation, arguments_: unknown) => unknown
  clock?: () => Date
  editsOnly?: boolean
}

export class CodexFilePreparationCleanupError extends CodexFileDeliveryError {
  constructor(readonly turn: CodexFileTurn, preparationError: unknown, cleanupError: unknown) {
    super('CODEX_FILE_PREPARATION_CLEANUP_REQUIRED', {
      cause: new AggregateError([preparationError, cleanupError], 'File preparation failed and cleanup is unconfirmed.'),
    })
    this.name = 'CodexFilePreparationCleanupError'
  }
}

/** A per-admission bridge for the EXISTING app-server transport. Does not spawn a
 * second Codex process, issue Operator/worker credentials, or configure App MCP.
 * No credential is returned in native inputs, tool definitions or tool results. */
export class CodexFileTurn {
  #accepted: AcceptedCodexFileTurn
  #dependencies: CodexFileTurnDependencies
  #deliveries: Delivery[] = []
  #working = new Map<string, WorkingCopy>()
  #registrations = new Set<string>()
  #paths = new Set<string>()
  #token: string | undefined
  #nativeTurnId: string | undefined
  #activation: Promise<void> | undefined
  #closing = false
  /** The turn owns its file session: renewal runs while the turn is open and stops when it closes. */
  #sessionOwner = new AbortController()
  #renewalFailure: Error | undefined
  #closeAttempt: Promise<void> | undefined
  #pending = new Set<Promise<CodexFileCallResult>>()

  private constructor(accepted: AcceptedCodexFileTurn, dependencies: CodexFileTurnDependencies) {
    this.#accepted = structuredClone(accepted)
    this.#dependencies = dependencies
  }

  static async prepare(accepted: AcceptedCodexFileTurn, dependencies: CodexFileTurnDependencies,
    signal?: AbortSignal): Promise<CodexFileTurn> {
    const turn = new CodexFileTurn(accepted, dependencies)
    try {
      turn.assertAdmission()
      for (const ref of turn.#accepted.attachments) {
        signal?.throwIfAborted()
        const opened = await dependencies.source.open(ref)
        let data: Buffer, document: FileRevision
        try {
          document = turn.assertAttachment(ref, opened.value)
          data = await collectCodexFileBytes(opened.stream, dependencies.limits.fileBytes, signal)
        } finally { opened.stream.destroy() }
        if (data.length !== document.byteSize || sha256(data) !== document.sha256) fail('CODEX_FILE_BYTES_CHANGED')
        // All turn inputs are read-only detached copies, even in project Write mode.
        // The agent explicitly obtains an editable registered copy through FIL-05.
        const copy = await turn.materialize(document.filename, document.mediaType, data, false)
        const delivery: Delivery = { ref: { ...ref }, revision: structuredClone(document), filename: document.filename, copy, firstFrameOnly: false }
        if (document.mediaType.startsWith('image/')) {
          if (!dependencies.prepareImage) fail('CODEX_IMAGE_CAPABILITY_REQUIRED')
          const image = await dependencies.prepareImage!(Buffer.from(data), document.mediaType)
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType)) fail('CODEX_IMAGE_PREPARATION_INVALID')
          const imageBytes = Buffer.from(image.bytes)
          delivery.image = image.mediaType === document.mediaType && sha256(imageBytes) === sha256(data)
            ? copy : await turn.materialize(`preview.${image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice(6)}`,
              image.mediaType, imageBytes, false)
          delivery.firstFrameOnly = image.firstFrameOnly
        }
        const current = await dependencies.source.recheck(ref)
        const currentDocument = turn.assertAttachment(ref, current)
        if (!sameScope(currentDocument, document)) fail('CODEX_FILE_BYTES_CHANGED')
        turn.#deliveries.push(delivery)
      }
      signal?.throwIfAborted()
      return turn
    } catch (error) {
      try { await turn.close() } catch (cleanupError) {
        throw new CodexFilePreparationCleanupError(turn, error, cleanupError)
      }
      throw error
    }
  }

  private assertAdmission(): void {
    const value = this.#accepted, { limits, host } = this.#dependencies
    if (!value.ownerPrincipalId || !value.nativeSessionId || !value.admissionId
      || !value.executionHostId || value.executionHostId !== host.executionHostId
      || !['read', 'write'].includes(value.projectMode) || !['posix', 'win32'].includes(host.pathStyle)
      || !Number.isFinite(value.expiresAt.getTime()) || value.expiresAt.getTime() <= this.now().getTime()
      || ![limits.fileBytes, limits.readBytes, limits.attachments].every((n) => Number.isSafeInteger(n) && n > 0)
      || limits.readBytes > limits.fileBytes || value.attachments.length > limits.attachments
      || new Set(value.attachments.map((ref) => ref.fileId)).size !== value.attachments.length
      || value.allowedTools.some((name) => !Object.values(CODEX_FILE_TOOL_ALIASES).includes(name))) fail('CODEX_FILE_ADMISSION_INVALID')
    if (value.scope.kind !== 'temporary'
      || (value.scope.chat.kind === 'operator' && value.scope.chat.ownerPrincipalId !== value.ownerPrincipalId)) fail('CODEX_FILE_SCOPE_INVALID')
    // Read-only harnesses cannot receive mutation tools.
    if (value.projectMode === 'read' && value.allowMutation) fail('CODEX_READ_MODE_FILE_EDIT_UNSUPPORTED')
  }

  private now(): Date { return this.#dependencies.clock?.() ?? new Date() }
  private documentRevision(value: FileWithRevision): FileRevision {
    if (value.file.scope.kind === 'job_execution' || value.revision.origin === 'job_output') fail('CODEX_FILE_DOCUMENT_REQUIRED')
    const document = FileRevisionSchema.safeParse(value.revision)
    if (!document.success) fail('CODEX_FILE_DOCUMENT_REQUIRED')
    return document.data
  }

  private assertAttachment(ref: MessageAttachmentRef, value: FileWithRevision): FileRevision {
    if (value.file.scope.kind === 'job_execution' || value.revision.origin === 'job_output') fail('CODEX_FILE_DOCUMENT_REQUIRED')
    if (pins(ref) !== pins(value.revision) || value.file.fileId !== ref.fileId
      || !sameScope(value.file.scope, this.#accepted.scope)) fail('CODEX_FILE_SCOPE_INVALID')
    if (value.file.state !== 'ready' || !('expiresAt' in value.file)
      || !Number.isFinite(Date.parse(value.file.expiresAt))
      || Date.parse(value.file.expiresAt) <= this.now().getTime()) fail('CODEX_FILE_UNAVAILABLE')
    if (!Number.isSafeInteger(value.revision.byteSize) || value.revision.byteSize < 0
      || value.revision.byteSize > this.#dependencies.limits.fileBytes
      || !/^[a-f0-9]{64}$/.test(value.revision.sha256)) fail('CODEX_FILE_BYTES_CHANGED')
    return this.documentRevision(value)
  }

  private async materialize(filename: string, mediaType: FileRevision['mediaType'], data: Buffer,
    writable: boolean): Promise<RegisteredCodexCopy> {
    if (this.#closing) fail('CODEX_FILE_TURN_CLOSED')
    if (data.length > this.#dependencies.limits.fileBytes) fail('CODEX_FILE_SIZE_LIMIT')
    if (writable && (this.#accepted.projectMode !== 'write' || !this.#accepted.allowMutation)) fail('CODEX_FILE_WRITE_DENIED')
    const expected = { executionHostId: this.#accepted.executionHostId, pathStyle: this.#dependencies.host.pathStyle,
      writable, byteSize: data.length, sha256: sha256(data) }
    const stream = Readable.from([Buffer.from(data)])
    let copy: RegisteredCodexCopy
    try { copy = await this.#dependencies.host.materialize({ filename, mediaType, bytes: stream, ...expected }) }
    finally { stream.destroy() }
    assertRegisteredCodexCopy(copy, expected)
    if (this.#registrations.has(copy.registrationId) || this.#paths.has(copy.executionPath)) fail('CODEX_FILE_HOST_COLLISION')
    this.#registrations.add(copy.registrationId); this.#paths.add(copy.executionPath)
    return copy
  }

  allowedTools(): readonly FileToolOperation[] {
    return [...new Set(this.#accepted.allowedTools)].filter((name) => !mutation(name) || this.#accepted.allowMutation)
  }

  /** Call immediately before turn/start. No startup prompt, skill bundle, or bytes. */
  async nativeInput(prompt: string): Promise<CodexFileInput[]> {
    if (this.#closing) fail('CODEX_FILE_TURN_CLOSED')
    for (const delivery of this.#deliveries) {
      const current = await this.#dependencies.source.recheck(delivery.ref)
      const currentDocument = this.assertAttachment(delivery.ref, current)
      if (!sameScope(currentDocument, delivery.revision)) fail('CODEX_FILE_BYTES_CHANGED')
    }
    const lines = this.#deliveries.map(({ ref, filename, copy, firstFrameOnly }) => JSON.stringify({
      filename, path: copy.executionPath, ...ref, ...(firstFrameOnly ? { image: 'first frame' } : {}),
    }))
    const copyHint = this.allowedTools().includes('files.create_working_copy') ? '; use files_create_working_copy to edit' : ''
    const note = lines.length ? `\n\nAttached files (read-only copies${copyHint}):\n${lines.join('\n')}\nFile tool scope (use this exact value for scope or destination): ${JSON.stringify(this.#accepted.scope)}` : ''
    return [{ type: 'text', text: prompt + note, text_elements: [] },
      ...this.#deliveries.flatMap((delivery): CodexFileInput[] => delivery.image
        ? [{ type: 'localImage', path: delivery.image.executionPath }] : [])]
  }

  /** AFTER native acknowledgement and durable onSubmitted persistence; BEFORE
   * dispatching staged item/tool/call requests. Never take this ID from tool args. */
  activate(nativeTurnId: string): Promise<void> {
    if (this.#closing || !nativeTurnId.trim()) return Promise.reject(new Error('CODEX_FILE_TURN_CLOSED'))
    if (this.#nativeTurnId && this.#nativeTurnId !== nativeTurnId) return Promise.reject(new Error('CODEX_FILE_TURN_MISMATCH'))
    if (this.#activation) return this.#activation
    this.#nativeTurnId = nativeTurnId
    this.#activation = (async () => {
      const value = this.#accepted
      const token = await this.#dependencies.files.sessions.issueForAcceptedSession({
        ownerPrincipalId: value.ownerPrincipalId, scope: value.scope, nativeSessionId: value.nativeSessionId,
        turnId: nativeTurnId, ...(value.messageId ? { messageId: value.messageId } : {}),
        allowMutation: value.allowMutation, allowedTools: [...this.allowedTools()],
      }, value.expiresAt)
      if (!/^gql_file_[A-Za-z0-9_-]{43}$/.test(token)) {
        await this.#dependencies.files.sessions.revoke(token)
        fail('CODEX_FILE_SESSION_INVALID')
      }
      this.#token = token
      this.renewSession(token)
    })()
    return this.#activation
  }

  private renewSession(token: string): void {
    let expiresAt = Math.min(this.#accepted.expiresAt.getTime(), this.now().getTime() + FILE_SESSION_LEASE_MS)
    void renewOwnedLeases({ signal: this.#sessionOwner.signal,
      leases: [{ name: 'file-tool session', renewWithinMs: FILE_SESSION_RENEWAL_WINDOW_MS,
        remainingMs: () => expiresAt - this.now().getTime(),
        renew: async () => { expiresAt = Date.parse(await this.#dependencies.files.sessions.renew(token)) } }],
      onFailure: error => { this.#renewalFailure = error; warnCodexFileError(error) },
    })
  }

  /** The adapter routes only this file-tool allowlist. No shell or path-read,
   * Operator, worker, or workflow Foreman Code entry points are accepted here. */
  call(request: CodexFileCall): Promise<CodexFileCallResult> {
    if (this.#closing) return Promise.resolve(refused())
    if (this.#renewalFailure) return Promise.resolve(refused(
      `File tools stopped because their session could not be renewed: ${leaseFailureCause(this.#renewalFailure)}`))
    const operation = this.dispatch(request).catch((error: unknown) => { warnCodexFileError(error); return refused() })
    this.#pending.add(operation)
    void operation.finally(() => this.#pending.delete(operation))
    return operation
  }

  private async dispatch(request: CodexFileCall): Promise<CodexFileCallResult> {
    const token = this.#token
    if (!token || request.threadId !== this.#accepted.nativeSessionId || request.turnId !== this.#nativeTurnId
      || (request.namespace != null && request.namespace !== '')
      || !Object.hasOwn(CODEX_FILE_TOOL_ALIASES, request.tool)) return refused()
    const tool = CODEX_FILE_TOOL_ALIASES[request.tool as keyof typeof CODEX_FILE_TOOL_ALIASES]
    if (!this.allowedTools().includes(tool)) return refused()
    await this.#dependencies.files.sessions.authenticate(token, tool)
    const files = this.#dependencies.files
    const arguments_ = this.#dependencies.parseCall(tool, request.arguments)
    if ((tool === 'files.create_working_copy' || tool === 'files.publish_result') && (!arguments_ || typeof arguments_ !== 'object'
      || !sameScope(Reflect.get(arguments_, tool === 'files.create_working_copy' ? 'destination' : 'scope'),
        this.#accepted.scope))) return refused()
    switch (tool) {
      case 'files.list': return textResult(await files.list(token, arguments_))
      case 'files.read': {
        const result = this.#dependencies.parseRead(arguments_, await files.read(token, arguments_))
        if (result.status === 'ready') this.documentRevision(result)
        return textResult(result, markdownReadText(result))
      }
      case 'files.write_working_copy':
      case 'files.apply_format_edit': {
        const id = arguments_ && typeof arguments_ === 'object' ? Reflect.get(arguments_, 'artifactId') as unknown : undefined
        if (typeof id !== 'string') return refused()
        const working = this.#working.get(id)
        if (!working || working.busy) return refused()
        working.busy = true
        try {
          await this.completeWorking(token, id, working)
          const result = tool === 'files.write_working_copy'
            ? await files.writeWorkingCopy(token, arguments_) : await files.applyFormatEdit(token, arguments_)
          return textResult(result)
        } finally { working.busy = false }
      }
      case 'files.create_working_copy': {
        const result = await files.createWorkingCopy(token, arguments_)
        const id = result.value.artifactId
        if (!this.#working.has(id)) {
          const data = await this.readPinned(token, result.value.source)
          const writeId = await files.artifacts.beginWrite(token, id)
          try {
            if (this.#dependencies.editsOnly) {
              await files.artifacts.completeWrite(token, id, writeId, Readable.from([data.bytes]))
              this.#working.set(id, { writeId, completed: true, busy: false })
            } else {
              const copy = await this.materialize(result.value.filename, data.mediaType, data.bytes, true)
              await files.sessions.authenticate(token, 'files.create_working_copy')
              this.#working.set(id, { copy, writeId, completed: false, busy: false })
            }
          } catch (error) { await files.artifacts.abortWrite(token, id, writeId); throw error }
        }
        const working = this.#working.get(id)!
        return textResult(result, `Working copy: ${JSON.stringify({ artifactId: id,
          ...(working.copy ? { path: working.copy.executionPath } : {}) })}`)
      }
      case 'files.publish_result': {
        // This is only a lookup. Artifact IDs never become paths, filenames, or URLs.
        const id = arguments_ && typeof arguments_ === 'object'
          ? Reflect.get(arguments_, 'artifactId') as unknown : undefined
        if (typeof id !== 'string') return refused()
        const working = this.#working.get(id)
        if (!working || working.busy) return refused()
        working.busy = true
        try {
          await this.completeWorking(token, id, working)
          return textResult(await files.publish(token, arguments_))
        } finally { working.busy = false }
      }
    }
  }

  private async completeWorking(token: string, id: string, working: WorkingCopy): Promise<void> {
    if (working.completed) return
    if (!working.copy) throw new Error('CODEX_WORKING_COPY_MISSING')
    const snapshot = await this.#dependencies.host.sealCompleted(working.copy.registrationId)
    await this.#dependencies.files.artifacts.completeWrite(token, id, working.writeId, snapshot)
    working.completed = true
  }

  private async readPinned(token: string, ref: MessageAttachmentRef): Promise<{ bytes: Buffer; mediaType: FileRevision['mediaType'] }> {
    const { files, limits, parseRead } = this.#dependencies
    const chunks: Buffer[] = []
    let offset = 0, revision: FileRevision | undefined
    for (;;) {
      const request = { ...ref, offset, length: limits.readBytes }
      const result = parseRead(request, await files.read(token, request))
      if (result.status !== 'ready') fail('CODEX_FILE_UNAVAILABLE')
      const ready = result
      const document = this.documentRevision(ready)
      if (revision && !sameScope(revision, document)) fail('CODEX_FILE_BYTES_CHANGED')
      revision = document
      const data = Buffer.from(ready.contentBase64, 'base64')
      if (data.length !== ready.byteLength || ready.offset !== offset || pins(ref) !== pins(ready.revision)
        || data.length > limits.readBytes || (!data.length && !ready.eof)) fail('CODEX_FILE_RANGE_INVALID')
      chunks.push(data); offset += data.length
      if (offset > limits.fileBytes) fail('CODEX_FILE_SIZE_LIMIT')
      if (ready.eof) break
    }
    const bytes = Buffer.concat(chunks, offset)
    if (!revision || bytes.length !== revision.byteSize || sha256(bytes) !== revision.sha256) fail('CODEX_FILE_BYTES_CHANGED')
    return { bytes, mediaType: revision.mediaType }
  }

  async publications(): Promise<MessageAttachmentRef[]> {
    if (!this.#token || this.#closing) fail('CODEX_FILE_TURN_CLOSED')
    return this.#dependencies.files.publishedForTurn(this.#token!)
  }

  /** Revoke first, drain in-flight calls, then release host allocations. Retry a
   * failed close explicitly; neither uncertainty nor cleanup permits a new turn. */
  close(): Promise<void> {
    if (this.#closeAttempt) return this.#closeAttempt
    this.#closing = true
    this.#sessionOwner.abort()
    const attempt = (async () => {
      await this.#activation?.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
      if (this.#token) { await this.#dependencies.files.sessions.revoke(this.#token); this.#token = undefined }
      await Promise.allSettled([...this.#pending])
      await this.#dependencies.host.close()
    })()
    this.#closeAttempt = attempt
    void attempt.catch(() => { if (this.#closeAttempt === attempt) this.#closeAttempt = undefined })
    return attempt
  }
}
