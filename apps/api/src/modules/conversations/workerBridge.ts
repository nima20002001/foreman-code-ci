import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  WorkerConversationCallbackSchema, WorkerConversationRpcRequestSchema,
  type WorkerConversationRpcRequest, type WorkerConversationBinding,
  type WorkerConversationProfileFacts,
  type WorkerClaudeAuthorityRequest,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import type { NativeHistory, NativeTerminalObservation } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import { MainWorkerFiles, type PrepareWorkerFiles } from './mainWorkerFiles.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { definedProperties } from '../definedProperties.js'
import { componentLogger } from '../diagnostics/logger.js'
import { assertWorkerChatRequestSize } from './chatInputSize.js'

export interface WorkerConversationCallbacks {
  profile?(): Promise<WorkerConversationProfileFacts>
  claudeAuthority?(request: WorkerClaudeAuthorityRequest, signal: AbortSignal): Promise<unknown>
  sessionObserved?(session: NativeSessionReference): Promise<void>
  submitted?(correlationId: string, identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>): Promise<void>
  settingsApplied?(): Promise<void>
  terminalObserved?(observation: NativeTerminalObservation): Promise<void>
  files?: PrepareWorkerFiles
}
export interface WorkerConversationChannel {
  binding: Readonly<DeviceSessionBinding>
  request(payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number;
    progressTimeoutMs?: number }): Promise<DeviceApplicationResult>
}
interface Admission {
  request: WorkerConversationRpcRequest
  channel: WorkerConversationChannel
  current(signal?: AbortSignal): Promise<void>
  callbacks: WorkerConversationCallbacks
  tail: Promise<unknown>
  session?: NativeSessionReference
  identities: Map<string, Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>>
  closed: boolean
  claudeGeneration?: string
  files?: MainWorkerFiles
}
const NATIVE_REQUEST_TIMEOUT_MS = 120_000
// A lost copy reply must leave time to retry within preparation's 30-second idle window.
const FILE_COPY_REQUEST_TIMEOUT_MS = 15_000
function denied(): never {
  throw new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED', 'The original admitted worker chat request is unavailable.', 403)
}

/** A worker callback needs a live Main-issued request; the nonce supplies no user authority. */
export class MainWorkerConversationBridge {
  private readonly admissions = new Map<string, Admission>()

  capture(input: { request: WorkerConversationRpcRequest; channel: WorkerConversationChannel;
    current(signal?: AbortSignal): Promise<void>; callbacks?: WorkerConversationCallbacks;
    recoveredSubmission?: NativeMessageSubmission; recoveredTurnId?: string }) {
    const admissionId = randomUUID()
    const request = WorkerConversationRpcRequestSchema.parse({ ...structuredClone(input.request), admissionId })
    assertWorkerChatRequestSize(request)
    const admission: Admission = { request, channel: input.channel, current: input.current,
      callbacks: input.callbacks ?? {}, tail: Promise.resolve(), identities: new Map(), closed: false }
    if (input.recoveredSubmission) {
      const submission = input.recoveredSubmission
      if (request.method !== 'conversation.reconcile' || request.binding.harness !== 'claude'
        || submission.nativeSessionId !== request.session.nativeSessionId
        || submission.clientCorrelationId !== request.correlationId) denied()
      admission.identities.set(submission.clientCorrelationId, { nativeSubmission: structuredClone(submission) })
    }
    if (input.recoveredTurnId) {
      const files = request.binding.harness === 'codex' && admission.callbacks.files
      if (request.method !== 'conversation.reconcile'
        || !('correlationId' in request) || !request.correlationId || !files) denied()
      admission.identities.set(request.correlationId, { nativeTurnId: input.recoveredTurnId })
    }
    this.admissions.set(admissionId, admission)
    const assertCurrent = async (signal?: AbortSignal) => {
      if (admission.closed || this.admissions.get(admissionId) !== admission) denied()
      await admission.current(signal)
      if (admission.closed || this.admissions.get(admissionId) !== admission) denied()
    }
    if (admission.callbacks.files) {
      admission.files = new MainWorkerFiles(admission.callbacks.files, async (copy, signal) => {
        await assertCurrent(signal)
        const reply = await admission.channel.request({ method: 'conversation.file-copy',
          binding: request.binding, admissionId, copy }, { signal, timeoutMs: FILE_COPY_REQUEST_TIMEOUT_MS })
        await assertCurrent(signal)
        if (reply.bytes !== undefined) denied()
        return reply.payload
      })
    }
    return {
      admissionId,
      async request(signal?: AbortSignal) {
        await assertCurrent(signal)
        // Opening a native session starts the harness on the Worker; the 30 s channel default is too short under load.
        const reply = await admission.channel.request(request, { ...(signal ? { signal } : {}),
          timeoutMs: NATIVE_REQUEST_TIMEOUT_MS, progressTimeoutMs: NATIVE_REQUEST_TIMEOUT_MS })
        await assertCurrent(signal)
        if (reply.bytes !== undefined) denied()
        return reply.payload
      },
      close: async () => {
        admission.closed = true
        this.admissions.delete(admissionId)
      },
    }
  }

  private async current(admission: Admission, binding: WorkerConversationBinding,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    if (admission.closed || !isDeepStrictEqual(admission.request.binding, binding)
      || !isDeepStrictEqual(admission.channel.binding, connection)) denied()
    await admission.current(signal)
    signal.throwIfAborted()
    if (admission.closed) denied()
  }

  async authorizeAppAccessChange(admissionId: string, previous: WorkerConversationBinding,
    next: WorkerConversationBinding, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const admission = this.admissions.get(admissionId)
    if (!admission || next.appMcpAccess !== 'scoped' || !sameConversationForAppAccess(previous, next)) denied()
    const request = admission.request
    if (!(request.method === 'conversation.open' && request.mode === 'attach'
      && isDeepStrictEqual(request.previousBinding, previous)) && request.method !== 'conversation.refresh-mcp') denied()
    await this.current(admission, next, connection, signal)
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<unknown> {
    const callback = WorkerConversationCallbackSchema.parse(raw)
    const admission = this.admissions.get(callback.admissionId)
    if (!admission) {
      componentLogger('devices').error({ callbackMethod: callback.method,
        conversationKind: callback.binding.owner.kind },
      'Worker callback has no live conversation request')
      denied()
    }
    await this.current(admission, callback.binding, connection, signal)
    if (callback.method === 'conversation.authorize') {
      if (!isDeepStrictEqual(admission.request, callback.request)) denied()
      return { authorized: true }
    }
    if (callback.method === 'conversation.profile') {
      if (!admission.callbacks.profile) denied()
      const facts = await admission.callbacks.profile()
      await this.current(admission, callback.binding, connection, signal)
      return facts
    }
    if (callback.method === 'conversation.file-copy-authorize') {
      if (!admission.files?.authorizes(callback.copy)) denied()
      return { authorized: true }
    }
    if (callback.method === 'conversation.files') {
      const request = admission.request
      const session = 'session' in request ? request.session : admission.session
      const recovering = request.method === 'conversation.reconcile' && request.correlationId
        && admission.identities.get(request.correlationId)?.nativeTurnId
      const missingFileInputs = callback.binding.appMcpAccess === 'scoped'
        && !recovering && !(request.method === 'conversation.start-turn' && request.fileInputs)
      if (!admission.files || callback.binding.harness !== 'codex' || missingFileInputs
        || !recovering && !['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
        || !('correlationId' in request) || request.correlationId !== callback.correlationId
        || !session || !isDeepStrictEqual(session, callback.session)) denied()
      if (callback.action.phase === 'input' && (!('prompt' in request) || request.prompt !== callback.action.prompt)) denied()
      const identity = admission.identities.get(callback.correlationId)
      const result = await admission.files.handle(callback.action, { session,
        clientCorrelationId: callback.correlationId, signal, nativeTurnId: identity?.nativeTurnId })
      await this.current(admission, callback.binding, connection, signal)
      return result
    }
    if (callback.method === 'conversation.claude-authority') {
      const request = admission.request
      const recovery = request.method === 'conversation.reconcile' && request.correlationId
        && admission.identities.has(request.correlationId)
      if (callback.binding.harness !== 'claude' || !admission.callbacks.claudeAuthority
        || !recovery && !['conversation.initial-turn', 'conversation.start-turn'].includes(request.method)) denied()
      const authority = callback.request
      if (authority.phase !== 'admission') {
        const identity = authority.identity
        const correlationId = 'correlationId' in request ? request.correlationId : undefined
        const submission = correlationId && admission.identities.get(correlationId)?.nativeSubmission
        const session = 'session' in request ? request.session : admission.session
        if (!session || !submission || session.nativeSessionId !== identity.nativeSessionId
          || submission.nativeSessionId !== identity.nativeSessionId
          || submission.nativeMessageId !== identity.nativeMessageId
          || submission.clientCorrelationId !== identity.clientCorrelationId
          || identity.clientCorrelationId !== correlationId
          || admission.claudeGeneration && admission.claudeGeneration !== identity.generation) denied()
        admission.claudeGeneration ??= identity.generation
      }
      const result = await admission.callbacks.claudeAuthority(authority, signal)
      await this.current(admission, callback.binding, connection, signal)
      return result
    }
    const task = admission.tail.then(async () => {
      await this.current(admission, callback.binding, connection, signal)
      if (callback.method === 'conversation.session-observed') {
        if (!['conversation.open', 'conversation.initial-turn'].includes(admission.request.method)
          || !admission.callbacks.sessionObserved || callback.session.harness !== callback.binding.harness) denied()
        if (admission.session && !isDeepStrictEqual(admission.session, callback.session)) denied()
        await admission.callbacks.sessionObserved(callback.session)
        admission.session = structuredClone(callback.session)
      } else if (callback.method === 'conversation.terminal-observed') {
        const request = admission.request
        const submission = callback.observation.submission
        const original = admission.identities.get(submission.clientCorrelationId)?.nativeSubmission
        const session = 'session' in request ? request.session : admission.session
        if (!['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
          || !('correlationId' in request) || request.correlationId !== submission.clientCorrelationId
          || !session || session.harness !== 'claude' || session.nativeSessionId !== submission.nativeSessionId
          || !isDeepStrictEqual(original, submission) || !admission.callbacks.terminalObserved) denied()
        const observation = callback.observation
        const history = observation.history
        await admission.callbacks.terminalObserved(definedProperties({ ...observation,
          history: history ? definedProperties({ ...history,
            responseDeliveries: history.responseDeliveries?.map(definedProperties),
            interactionDeliveries: history.interactionDeliveries?.map(definedProperties),
          }) : undefined,
        }))
      } else if (callback.method === 'conversation.settings-applied') {
        const request = admission.request
        if (!('correlationId' in request) || request.correlationId !== callback.correlationId
          || !['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
          || !admission.callbacks.settingsApplied) denied()
        await admission.callbacks.settingsApplied()
      } else {
        const request = admission.request
        if (!('correlationId' in request) || request.correlationId !== callback.correlationId
          || !['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
          || !admission.callbacks.submitted) denied()
        const session = 'session' in request ? request.session : admission.session
        if (!session || callback.identity.nativeSubmission && (
          callback.identity.nativeSubmission.nativeSessionId !== session.nativeSessionId
          || callback.identity.nativeSubmission.clientCorrelationId !== callback.correlationId)) denied()
        const previous = admission.identities.get(callback.correlationId)
        if (previous?.nativeTurnId && callback.identity.nativeTurnId !== undefined
          && previous.nativeTurnId !== callback.identity.nativeTurnId
          || previous?.nativeSubmission && callback.identity.nativeSubmission
            && !isDeepStrictEqual(previous.nativeSubmission, callback.identity.nativeSubmission)) denied()
        const identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'> = {
          ...(callback.identity.nativeTurnId !== undefined ? { nativeTurnId: callback.identity.nativeTurnId } : {}),
          ...(callback.identity.nativeSubmission !== undefined ? { nativeSubmission: callback.identity.nativeSubmission } : {}),
        }
        await admission.callbacks.submitted(callback.correlationId, identity)
        admission.identities.set(callback.correlationId, { ...previous, ...identity })
      }
      await this.current(admission, callback.binding, connection, signal)
      return { acknowledged: true }
    })
    admission.tail = task.then(() => undefined, () => undefined)
    return task
  }

  async close() {
    for (const admission of this.admissions.values()) admission.closed = true
    this.admissions.clear()
  }
}
