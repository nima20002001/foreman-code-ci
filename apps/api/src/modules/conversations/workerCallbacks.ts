import { isDeepStrictEqual } from 'node:util'
import { WorkerConversationProfileFactsSchema,
  type WorkerConversationRpcRequest, type WorkerConversationProfileFacts } from '@foreman-code/contracts/remote-execution-rpc'
import type { WorkerClaudeAuthorityRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { WorkerConversationFileAction, WorkerConversationFileCopy } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationHostPorts } from './workerHost.js'
import type { WorkerConversationChannel } from './workerBridge.js'
import { DomainError } from '../errors.js'

/** Uses the existing paired channel; Main alone checks message/control authority. */
export function workerConversationCallbacks(input: {
  currentBinding(): Readonly<DeviceSessionBinding>
  capture(): WorkerConversationChannel | undefined
}): Pick<WorkerConversationHostPorts, 'authorize' | 'observeSession' | 'observeSubmission' | 'observeSettings' | 'observeTerminal'> & {
  profile(source: WorkerConversationRpcRequest, signal: AbortSignal): Promise<WorkerConversationProfileFacts>
  claudeAuthority(source: WorkerConversationRpcRequest, request: WorkerClaudeAuthorityRequest,
    signal: AbortSignal): Promise<unknown>
  files(source: WorkerConversationRpcRequest, session: NativeSessionReference, correlationId: string,
    action: WorkerConversationFileAction, signal: AbortSignal): Promise<unknown>
  authorizeCopy(source: WorkerConversationRpcRequest, copy: WorkerConversationFileCopy,
    signal: AbortSignal): Promise<void>
} {
  const request = async (source: WorkerConversationRpcRequest, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (!source.admissionId) throw new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED',
      'The native operation has no live Main-issued conversation admission.', 403)
    signal.throwIfAborted()
    const current = input.currentBinding()
    const channel = input.capture()
    if (!channel || !isDeepStrictEqual(channel.binding, current)) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE',
      'The original paired Main channel is unavailable.', 409)
    const preparingFiles = payload.method === 'conversation.files'
      && (payload.action as WorkerConversationFileAction).phase === 'prepare'
    const reply = await channel.request({ ...payload, binding: source.binding, admissionId: source.admissionId },
      { signal, ...(preparingFiles ? { progressTimeoutMs: 30_000 } : {}) })
    signal.throwIfAborted()
    if (reply.bytes !== undefined || !isDeepStrictEqual(input.currentBinding(), current)) {
      throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The conversation callback channel changed.', 409)
    }
    return reply.payload
  }
  return {
    files: (source, session, correlationId, action, signal) => request(source,
      { method: 'conversation.files', session, correlationId, action }, signal),
    authorizeCopy: async (source, copy, signal) => {
      const result = await request(source, { method: 'conversation.file-copy-authorize', copy }, signal)
      if (!result || typeof result !== 'object' || !('authorized' in result) || result.authorized !== true) {
        throw new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED', 'The attachment copy was not authorized.', 403)
      }
    },
    claudeAuthority: (source, authority, signal) => request(source,
      { method: 'conversation.claude-authority', request: authority }, signal),
    profile: async (source, signal) => WorkerConversationProfileFactsSchema.parse(
      await request(source, { method: 'conversation.profile' }, signal)),
    authorize: async (source, connection, signal) => {
      if (!isDeepStrictEqual(input.currentBinding(), connection)) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE',
        'The native operation addresses a stale worker channel.', 409)
      const result = await request(source, { method: 'conversation.authorize', request: source }, signal)
      if (!result || typeof result !== 'object' || !('authorized' in result) || result.authorized !== true) {
        throw new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED', 'Main did not authorize this native operation.', 403)
      }
    },
    observeSession: async (_binding, session, source, signal) => {
      await request(source, { method: 'conversation.session-observed', session }, signal)
    },
    observeSubmission: async (_binding, correlationId, identity, source, signal) => {
      await request(source, { method: 'conversation.submitted', correlationId, identity }, signal)
    },
    observeSettings: async (source, correlationId, signal) => {
      await request(source, { method: 'conversation.settings-applied', correlationId }, signal)
    },
    observeTerminal: async (source, observation, signal) => {
      await request(source, { method: 'conversation.terminal-observed', observation }, signal)
    },
  }
}
