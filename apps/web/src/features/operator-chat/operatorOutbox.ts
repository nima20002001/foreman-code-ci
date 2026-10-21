import { SendOperatorMessageRequestSchema, type SendOperatorMessageRequest, type OperatorChatSettings } from '@foreman-code/contracts'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { sameAttachmentRefs } from '../conversations/chatAttachmentAttempt'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'

const outboxLock = 'graphql.operator-outbox.v1'
const storageError = 'Durable message storage is unavailable. Sending is disabled to avoid repeating a command after a lost response.'

type AttemptLedger = { uncertain: boolean; rejected: number; inFlight: string[] }
type PendingMessage = { command?: SendOperatorMessageRequest; error?: string; sendFailure?: string;
  definitiveFailure?: boolean; inFlight?: boolean; ledger?: AttemptLedger }

function readKey(key: string): PendingMessage {
  try {
    const value = window.localStorage.getItem(key)
    if (value === null) return {}
    const saved = JSON.parse(value)
    const current = saved?.version === 2
    const command = SendOperatorMessageRequestSchema.safeParse(current ? saved.request : saved?.command ?? saved)
    if (!command.success) return { error: 'The saved pending command is invalid. Recover its receipt before sending another command.' }
    // A pre-upgrade record has no attempt history. Neither its last error nor a
    // matching error message can establish that an earlier attempt was rejected.
    const ledger: AttemptLedger = current ? saved.ledger : { uncertain: true, rejected: 0, inFlight: [] }
    if (!ledger || typeof ledger.uncertain !== 'boolean' || !Number.isSafeInteger(ledger.rejected) || ledger.rejected < 0
      || !Array.isArray(ledger.inFlight) || !ledger.inFlight.every((id: unknown) => typeof id === 'string' && id.length > 0)
      || new Set(ledger.inFlight).size !== ledger.inFlight.length) return { error: storageError }
    return { command: command.data, ledger, inFlight: ledger.inFlight.length > 0,
      definitiveFailure: !ledger.uncertain && ledger.rejected > 0 && ledger.inFlight.length === 0,
      ...(typeof saved?.sendFailure === 'string' ? { sendFailure: saved.sendFailure } : {}) }
  } catch { return { error: storageError } }
}

function writeKey(key: string, command: SendOperatorMessageRequest, ledger: AttemptLedger, sendFailure?: string): void {
  // Deliberately not a v1 `command` envelope: older tabs must fail closed rather
  // than discard a v2 command using their last-error/message-string heuristic.
  const value = JSON.stringify({ version: 2, request: command, ledger, ...(sendFailure ? { sendFailure } : {}) })
  window.localStorage.setItem(key, value)
  if (window.localStorage.getItem(key) !== value) throw new Error(storageError)
}

export function readPendingOperatorMessage(id: string): PendingMessage {
  try { return readKey(protectedKey('outbox', id)) } catch { return { error: storageError } }
}

/** Persist the attempt before HTTP. Clearing in any tab observes this fence. */
export function beginOperatorMessageAttempt(id: string, command: SendOperatorMessageRequest): Promise<string> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error) throw new Error(pending.error)
    if (!pending.command || JSON.stringify(pending.command) !== JSON.stringify(SendOperatorMessageRequestSchema.parse(command))) {
      throw new Error('The pending message changed or was acknowledged in another tab. Recover its receipt before retrying.')
    }
    const attemptId = crypto.randomUUID()
    const ledger = pending.ledger!
    writeKey(key, pending.command, { ...ledger, inFlight: [...ledger.inFlight, attemptId] }, pending.sendFailure)
    return attemptId
  })
}

/** A definitive rejection only settles this attempt, never previous uncertainty. */
export function recordOperatorMessageFailure(id: string, requestId: string, message: string, definitive = false,
  attemptId?: string): Promise<void> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error || pending.command?.requestId !== requestId) return
    const ledger = pending.ledger!
    if (attemptId && !ledger.inFlight.includes(attemptId)) return
    const rejected = Boolean(attemptId && definitive)
    writeKey(key, pending.command, {
      uncertain: ledger.uncertain || !rejected,
      rejected: ledger.rejected + (rejected ? 1 : 0),
      inFlight: ledger.inFlight.filter((id) => id !== attemptId),
    }, message)
  })
}

/** Only a fully tracked lifetime of pre-admission rejections can be abandoned. */
export function discardDefinitivelyRejectedOperatorMessage(id: string, requestId: string): Promise<boolean> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error || pending.command?.requestId !== requestId || !pending.definitiveFailure) return false
    window.localStorage.removeItem(key)
    return true
  })
}

/** Cross-document exclusion, not a same-tab mutex or a read/write/read storage guess. */
async function exclusive<T>(id: string, work: (key: string) => T): Promise<T> {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration()
  const key = protectedKey('outbox', id)
  const locks = globalThis.navigator?.locks
  if (!locks) throw new Error('This browser cannot safely coordinate Operator messages across tabs. Use a browser with Web Locks enabled in a secure context.')
  return locks.request(outboxLock, { mode: 'exclusive', signal: sessionSignal() }, () => {
    const check = () => {
      assertSession(generation)
      // Storage events may not have reached this tab yet. Compare the durable
      // identity epoch directly, both after waiting for the lock and after work.
      if (sessionIsSwitching() || key !== protectedKey('outbox', id)) throw new SessionChangedError()
    }
    check()
    const value = work(key) // Synchronous, bounded storage work only; no HTTP under this lock.
    check()
    return value
  })
}

/** Reserve once before submission. Every tab and every lost-response retry reuses that identity. */
export function reserveOperatorMessage(id: string, content: string, route: string, settings?: OperatorChatSettings,
  forkExpectedRevision?: number, binding?: Pick<SendOperatorMessageRequest, 'configurationVersionId' | 'defaultsRevision' | 'sessionMode'>,
  attachments: readonly MessageAttachmentRef[] = []): Promise<SendOperatorMessageRequest> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error) throw new Error(pending.error)
    if (pending.command) {
      if (pending.command.content !== content || pending.command.sessionMode !== binding?.sessionMode || !sameAttachmentRefs(pending.command.attachments, attachments)) throw new Error('Retry the previous pending message before sending a different command. Your new draft is preserved.')
      return pending.command // Includes the originally accepted route context and configuration binding.
    }
    const command = SendOperatorMessageRequestSchema.parse({ requestId: crypto.randomUUID(), content, context: { route },
      ...(settings ? { settings } : {}), ...(forkExpectedRevision === undefined ? {} : { forkExpectedRevision }), ...binding,
      ...(attachments.length ? { attachments: attachments.map((pin) => ({ ...pin })) } : {}) })
    writeKey(key, command, { uncertain: false, rejected: 0, inFlight: [] })
    return command
  })
}

/** Guard the actual network boundary as well as initial reservation, including a stale retry button. */
export function assertOperatorMessageReserved(id: string, command: SendOperatorMessageRequest): void {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const pending = readPendingOperatorMessage(id)
  if (pending.error) throw new Error(pending.error)
  if (!pending.command || JSON.stringify(pending.command) !== JSON.stringify(SendOperatorMessageRequestSchema.parse(command))) {
    throw new Error('The pending message changed or was acknowledged in another tab. Reload its receipt; no new request identity was generated.')
  }
}

/** Compare-and-remove shares the reservation lock, so a late ACK cannot erase a newer request. */
export function acknowledgeOperatorMessage(id: string, requestId: string): Promise<boolean> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error) throw new Error(pending.error)
    if (pending.command?.requestId !== requestId) return false
    window.localStorage.removeItem(key)
    return true
  })
}
