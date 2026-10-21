import { useEffect } from 'react'
import { create } from 'zustand'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { nextDraftKey } from '../graph/nextDraft/state'
import { parseBoardStart, type BoardStartInput } from './startClient'

/** One principal-scoped durable journal and cross-tab lock for current Start.
 * Invalid/retired stored tags are retained for explicit recovery, never dispatched. */
export const boardStartJournalKey = (key: string) => protectedKey('outbox', `next-draft-start:${key}`)
const storageError = 'Pending Start storage is unavailable. No replacement command can be sent.'
type Local = { request?: BoardStartInput; error?: string }
const useOutbox = create<{ records: Record<string, Local>; set(key: string, value: Local): void }>((set) => ({
  records: {}, set: (key, value) => set((state) => ({ records: { ...state.records, [key]: value } })),
}))
const localKey = (key: string) => JSON.stringify([sessionGeneration(), boardStartJournalKey(key)])
const publish = (key: string, request?: BoardStartInput) => useOutbox.getState().set(localKey(key), { request })

export function readBoardStart(key: string): BoardStartInput | undefined {
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined') return undefined
  let raw: string | null
  try { raw = window.localStorage.getItem(boardStartJournalKey(key)) } catch { throw new Error(storageError) }
  if (raw === null) return undefined
  try {
    const request = parseBoardStart(JSON.parse(raw))
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    return request
  } catch { throw new Error('The retained Start is invalid or out of scope. Recover its receipt before sending another command.') }
}

async function locked<T>(key: string, work: () => T): Promise<T> {
  const generation = sessionGeneration()
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely reserve a cross-tab Start. No Run was sent.')
  return navigator.locks.request(boardStartJournalKey(key), () => { assertSession(generation); return work() })
}

export async function reserveBoardStart(key: string, candidate: BoardStartInput): Promise<BoardStartInput> {
  return locked(key, () => {
    const existing = readBoardStart(key)
    if (existing) { publish(key, existing); return existing }
    const request = parseBoardStart(candidate)
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    const raw = JSON.stringify(request)
    try {
      window.localStorage.setItem(boardStartJournalKey(key), raw)
      if (window.localStorage.getItem(boardStartJournalKey(key)) !== raw) throw new Error(storageError)
    } catch { throw new Error(storageError) }
    publish(key, request)
    return request
  })
}

function removeExact(key: string, request: BoardStartInput): void {
  const current = readBoardStart(key)
  if (!current || !sameWorkflowValue(current, request)) throw new Error('The retained Start changed. Its journal was not cleared.')
  try {
    window.localStorage.removeItem(boardStartJournalKey(key))
    if (window.localStorage.getItem(boardStartJournalKey(key)) !== null) throw new Error(storageError)
  } catch { throw new Error(storageError) }
  publish(key)
}
export function acknowledgeBoardStart(key: string, request: BoardStartInput): Promise<'removed' | 'absent' | 'superseded'> {
  return locked(key, () => {
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    const current = readBoardStart(key)
    if (!current) {
      publish(key)
      return 'absent'
    }
    if (current.commandId !== request.commandId) {
      publish(key, current)
      return 'superseded'
    }
    removeExact(key, request)
    return 'removed'
  })
}

/** Only an explicit unsupported-version terminal rejection clears the exact command.
 * Denial, stale pins and uncertain transport retain it; they cannot prove a lost Start was not admitted. */
export async function rejectBoardStart(key: string, request: BoardStartInput, error: unknown): Promise<boolean> {
  if (!ApiError.is(error) || error.status !== 409
    || !['WORKFLOW_VERSION_UNSUPPORTED', 'EXECUTION_SEMANTICS_UNSUPPORTED'].includes(error.code)) return false
  return locked(key, () => { removeExact(key, request); return true })
}

/** Zustand stores only the local journal view. The caller's Query mutation owns requests. */
export function useBoardStartOutbox(key: string): Local {
  const identity = localKey(key)
  const local = useOutbox((state) => state.records[identity])
  useEffect(() => {
    const read = () => {
      try { publish(key, readBoardStart(key)) } catch (error) {
        useOutbox.getState().set(identity, { error: error instanceof Error ? error.message : storageError })
      }
    }
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === boardStartJournalKey(key)) read() }
    read()
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [key, identity])
  return local ?? { error: 'Checking retained Start storage.' }
}

/** Called only by the existing principal/session teardown, never by Discard. */
export function clearBoardStartStorage(): void {
  useOutbox.setState({ records: {} })
  if (typeof window === 'undefined') return
  try {
    const prefix = boardStartJournalKey('')
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(prefix)) window.localStorage.removeItem(key)
    }
  } catch { /* Protected principal teardown also removes its outbox namespace. */ }
}
