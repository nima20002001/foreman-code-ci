import { omitProperties } from '../../shared/omitProperties.js'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import type { AgentSubject, SessionMode, SessionPreferences } from '@foreman-code/contracts'

export interface AcceptedChatSettings {
  sessionMode: SessionMode
  sessionPreferences: SessionPreferences
  profileKey: string
}

export interface PreparedChatInput {
  /** Actual composed prompt, including accepted skills, handoff and file instructions. */
  prompt: string
  /** Every actual Worker input frame, with accepted binding/configuration/session/credential fields. */
  workerFrames?: readonly WorkerConversationRpcRequest[]
}
/** Persisted with owner admission. No credential or native frame is retained here. */
export interface AcceptedChatInput {
  prompt: string
  startup: boolean
  workerProofs: Array<{ method: WorkerConversationRpcRequest['method']; inputHash: string }>
  /** Admission snapshots defaults once; dispatch never reads a later desired value. */
  settings?: AcceptedChatSettings
  conversationContext?: { subject: Extract<AgentSubject, { kind: 'conversation' }>; workflowVersionId: string; workingDirectory: string }
  /** Both variants were preflighted. The existing claim lock chooses one, once. */
  subsequent?: Omit<AcceptedChatInput, 'subsequent'> & { startup: false }
}

export function workerInputProof(frame: WorkerConversationRpcRequest): AcceptedChatInput['workerProofs'][number] {
  const input = omitProperties(frame, ['admissionId'])
  // A credential can be reissued, but its serialized size cannot invalidate the accepted envelope.
  // All target/configuration/session/prompt fields remain part of the immutable proof.
  const safe = 'applicationAccess' in input && input.applicationAccess
    ? { ...input, applicationAccess: { kind: input.applicationAccess.kind,
      serializedBytes: Buffer.byteLength(JSON.stringify(input.applicationAccess)) } } : input
  return { method: frame.method, inputHash: commandInputHash(safe) }
}

export function restoreAcceptedChatInput(manager: object, correlationId: string, accepted: AcceptedChatInput): void {
  if (!accepted.workerProofs.length) return
  if (!('restorePreparedInput' in manager) || typeof manager.restorePreparedInput !== 'function') {
    throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The native manager cannot restore this accepted Worker input.', 503)
  }
  manager.restorePreparedInput(correlationId, accepted)
}

export function validateChatInput(input: { content: string; attachments?: readonly unknown[] | undefined }): void {
  if (!input.content.trim() && !input.attachments?.length) {
    throw new DomainError('CHAT_INPUT_EMPTY', 'Write a message or attach a file before sending.', 422)
  }
}

function validatePrompt(prompt: string): void {
  if (!prompt.length || prompt.length > 1_000_000) {
    throw new DomainError('CHAT_INPUT_TOO_LARGE', 'The composed native prompt exceeds the supported input length.', 413)
  }
}

/** This is the actual serialized application payload; no guessed reserve or text-only byte cap. */
export function prepareWorkerChatFrame(input: WorkerConversationRpcRequest): WorkerConversationRpcRequest {
  const value = { ...input, admissionId: input.admissionId ?? randomUUID() }
  if ('prompt' in value) validatePrompt(value.prompt)
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > DEVICE_APPLICATION_JSON_BYTES) throw new DomainError('CHAT_INPUT_TOO_LARGE',
    'The complete native chat request exceeds the Worker transport limit.', 413,
    { bytes, maximumBytes: DEVICE_APPLICATION_JSON_BYTES })
  return WorkerConversationRpcRequestSchema.parse(value)
}

export function validatePreparedChatInput(prepared: PreparedChatInput, workerRequired: boolean): void {
  validatePrompt(prepared.prompt)
  if (workerRequired && !prepared.workerFrames?.length) {
    throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The exact Worker input must be prepared before accepting this message.', 503)
  }
  for (const frame of prepared.workerFrames ?? []) prepareWorkerChatFrame(frame)
  if (prepared.workerFrames?.length && !prepared.workerFrames.some(frame => 'prompt' in frame && frame.prompt === prepared.prompt)) {
    throw new DomainError('CHAT_PREFLIGHT_MISMATCH', 'The prepared native request does not contain the accepted composed prompt.', 409)
  }
}

/** A remote admission cannot silently fall back to validating only user text. */
export async function preflightChatInput(input: { content: string; attachments?: readonly unknown[] | undefined }, options: {
  workerRequired: boolean; prompt: string; startup?: boolean; settings?: AcceptedChatSettings; prepare?: () => Promise<PreparedChatInput>
}): Promise<AcceptedChatInput> {
  validateChatInput(input)
  if (!options.prepare && options.workerRequired) {
    throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The exact Worker input must be prepared before accepting this message.', 503)
  }
  const prepared = options.prepare ? await options.prepare() : { prompt: options.prompt }
  validatePreparedChatInput(prepared, options.workerRequired)
  if (prepared.prompt !== options.prompt) throw new DomainError('CHAT_PREFLIGHT_MISMATCH',
    'The native preparation changed the accepted message prompt.', 409)
  return { prompt: prepared.prompt, startup: options.startup ?? false,
    ...(options.settings ? { settings: structuredClone(options.settings) } : {}),
    workerProofs: (prepared.workerFrames ?? []).map(frame => workerInputProof(prepareWorkerChatFrame(frame))) }
}

/** The retained user message stays exact; only the native prompt needs text for files. */
export function nativeChatPrompt(content: string, hasAttachments: boolean): string {
  return content.trim() || !hasAttachments ? content : 'Please review the attached files.'
}
