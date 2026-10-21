import { CHAT_MAX_MESSAGE_CHARACTERS, WORKER_CHAT_MAX_JSON_BYTES, chatJsonBytes } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'

// Covers bounded RPC fields, correlation IDs, the 16,384-character application
// token (including JSON escapes), and metadata added by the file callback envelope.
// Agent configuration replacement can also add a handoff: its generator caps JSON-quoted
// source lines at 48 KiB, so embedding that text costs at most roughly another 96 KiB.
const WORKER_CHAT_ENVELOPE_RESERVE_BYTES = 256 * 1024

/** Admission-time upper bound; callers provide every unbounded saved input to the RPC. */
export function assertWorkerChatInputSize(input: { prompt: string; metadata: readonly unknown[] }): void {
  // A configuration transition can carry both previous and requested bindings/configurations.
  const byteSize = chatJsonBytes({ prompt: input.prompt })
    + 2 * chatJsonBytes(input.metadata) + WORKER_CHAT_ENVELOPE_RESERVE_BYTES
  if (input.prompt.length > CHAT_MAX_MESSAGE_CHARACTERS || byteSize > WORKER_CHAT_MAX_JSON_BYTES) {
    throw new DomainError('CHAT_MESSAGE_TOO_LARGE',
      'The message, saved context and configuration exceed the Worker 1 MiB request limit. Shorten the message or context, or send the content as an attachment.',
      400, { limitBytes: WORKER_CHAT_MAX_JSON_BYTES })
  }
}

type PendingSessionTurn = Omit<Extract<WorkerConversationRpcRequest, { method: 'conversation.start-turn' }>, 'session'>

/** A first Codex turn gets its session identity after creation; the bridge checks the completed frame too.
 * Authorization callbacks repeat the binding, but carry prompt/configuration only in the request. */
export function assertWorkerChatRequestSize(request: WorkerConversationRpcRequest | PendingSessionTurn): void {
  const callback = { method: 'conversation.authorize', admissionId: request.admissionId,
    binding: request.binding, request }
  if (chatJsonBytes(request) > WORKER_CHAT_MAX_JSON_BYTES || chatJsonBytes(callback) > WORKER_CHAT_MAX_JSON_BYTES) {
    throw new DomainError('CHAT_MESSAGE_TOO_LARGE',
      'The message, saved context and configuration exceed the Worker 1 MiB request limit. Shorten the message or context, or send the content as an attachment.',
      400, { limitBytes: WORKER_CHAT_MAX_JSON_BYTES })
  }
}
