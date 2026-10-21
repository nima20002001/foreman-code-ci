import { useEffect } from 'react'
import { create } from 'zustand'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MemoryBoardMutationSchema, type MemoryBoardMutation } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { commandWasRejected } from '../../shared/api/commandAttempt'
import { ApiError } from '../../shared/api/client'
import { refreshMemory } from './queries'
import type { MemoryBoardClient, MemoryReceipt } from './ports'

export type RetainedMemoryCommand = MemoryBoardMutation & { commandId: string }
type LocalRecord = { command?: RetainedMemoryCommand; error?: string; checked: boolean }
const storageMessage = 'Couldn’t keep this save for recovery. Copy your changes and retry.'
const key = (boardId: string) => protectedKey('outbox', `memory-board:${boardId}`)
const localKey = (boardId: string) => `${sessionGeneration()}:${key(boardId)}`
const useJournal = create<{ records: Record<string, LocalRecord>; set(id: string, value: LocalRecord): void }>((set) => ({
  records: {}, set: (id, value) => set((state) => ({ records: { ...state.records, [id]: value } })),
}))
const publish = (boardId: string, command?: RetainedMemoryCommand) => useJournal.getState().set(localKey(boardId), { command, checked: true })

export function readMemoryCommand(boardId: string): RetainedMemoryCommand | undefined {
  if (sessionIsSwitching()) throw new SessionChangedError()
  let raw: string | null
  try { raw = window.localStorage.getItem(key(boardId)) } catch { throw new Error(storageMessage) }
  if (raw === null) return undefined
  if (new TextEncoder().encode(raw).byteLength > 65_536) throw new Error('The retained save is too large. Recover its receipt before saving again.')
  try {
    const command = MemoryBoardMutationSchema.parse(JSON.parse(raw))
    if (command.boardId !== boardId || !command.commandId) throw new Error('Scope mismatch')
    return { ...command, commandId: command.commandId }
  } catch { throw new Error('The retained save is invalid or out of scope. Recover it before sending another command.') }
}
async function locked<T>(boardId: string, operation: () => T): Promise<T> {
  const generation = sessionGeneration()
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error(storageMessage)
  return navigator.locks.request(key(boardId), () => { assertSession(generation); return operation() })
}
export function reserveMemoryCommand(boardId: string, input: MemoryBoardMutation): Promise<RetainedMemoryCommand> {
  return locked(boardId, () => {
    const parsed = MemoryBoardMutationSchema.parse({ ...input, commandId: input.commandId ?? crypto.randomUUID() })
    if (parsed.boardId !== boardId || !parsed.commandId) throw new Error('The save belongs to another board.')
    const command: RetainedMemoryCommand = { ...parsed, commandId: parsed.commandId }
    const existing = readMemoryCommand(boardId)
    if (existing) {
      publish(boardId, existing)
      if (!sameWorkflowValue(existing, command)) throw new Error('One save needs confirmation. Check its status before saving another change.')
      return existing
    }
    const raw = JSON.stringify(command)
    if (new TextEncoder().encode(raw).byteLength > 65_536) throw new Error('Save fewer changes at a time (64 KiB maximum).')
    try {
      window.localStorage.setItem(key(boardId), raw)
      if (window.localStorage.getItem(key(boardId)) !== raw) throw new Error(storageMessage)
    } catch { throw new Error(storageMessage) }
    publish(boardId, command)
    return command
  })
}
export function acknowledgeMemoryCommand(boardId: string, command: RetainedMemoryCommand): Promise<void> {
  return locked(boardId, () => {
    const current = readMemoryCommand(boardId)
    if (!current) { publish(boardId); return }
    if (!sameWorkflowValue(current, command)) { publish(boardId, current); return }
    try {
      window.localStorage.removeItem(key(boardId))
      if (window.localStorage.getItem(key(boardId)) !== null) throw new Error(storageMessage)
    } catch { throw new Error(storageMessage) }
    publish(boardId)
  })
}
function useRetainedMemoryCommand(boardId: string): LocalRecord {
  const identity = localKey(boardId)
  const local = useJournal((state) => state.records[identity])
  useEffect(() => {
    const read = () => {
      try { publish(boardId, readMemoryCommand(boardId)) } catch (error) {
        useJournal.getState().set(identity, { checked: true, error: error instanceof Error ? error.message : storageMessage })
      }
    }
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === key(boardId)) read() }
    read(); window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [boardId, identity])
  return local ?? { checked: false }
}
type SaveAction = { kind: 'save'; command: MemoryBoardMutation } | { kind: 'check' | 'retry' }
export function useMemorySave(client: MemoryBoardClient, boardId: string) {
  const retained = useRetainedMemoryCommand(boardId), cache = useQueryClient()
  const operation = useMutation({
    retry: false,
    mutationFn: async (action: SaveAction): Promise<{ receipt: MemoryReceipt; command: RetainedMemoryCommand } | undefined> => {
      const generation = sessionGeneration()
      const command = action.kind === 'save'
        ? await reserveMemoryCommand(boardId, action.command) : readMemoryCommand(boardId)
      if (!command) return undefined
      let rejectedReceipt = false
      try {
        let receipt: MemoryReceipt
        if (action.kind === 'check') {
          const read = await client.readCommand(boardId, command.commandId)
          if (read.commandId !== command.commandId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The receipt belongs to another save.' })
          if (read.state === 'unknown') return undefined
          if (read.state === 'rejected') {
            rejectedReceipt = true
            throw new ApiError(read.error, read.error.status)
          }
          receipt = read.receipt
        } else receipt = await client.mutate(command)
        assertSession(generation)
        await acknowledgeMemoryCommand(boardId, command)
        // Receipt proves an outcome, not current state. Never install an old receipt as live data.
        void refreshMemory(cache, boardId)
        return { receipt, command }
      } catch (error) {
        assertSession(generation)
        if (rejectedReceipt || (action.kind !== 'check' && commandWasRejected(error))) {
          await acknowledgeMemoryCommand(boardId, command)
        }
        throw error
      }
    },
  })
  return {
    ...operation, retained, data: operation.data?.receipt, confirmedCommand: operation.data?.command,
    save: async (command: MemoryBoardMutation) => (await operation.mutateAsync({ kind: 'save', command }))?.receipt,
    check: () => operation.mutate({ kind: 'check' }),
    retryOriginal: () => operation.mutate({ kind: 'retry' }),
  }
}
