import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { MemoryBoardScope, MemoryCard, MemoryNote } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import type { CardFilter, MemoryBoardClient, MemoryBoardView, MemoryChange, MemoryConnection, MemoryPage, MemoryCardDetail } from './ports'

export const memoryKey = (boardId: string) => ['memory-board', sessionGeneration(), boardId] as const
export const memorySnapshotKey = (boardId: string) => [...memoryKey(boardId), 'snapshot'] as const
// Editors unmount the read views; reopening must refresh queries invalidated by a save.
const quiet = { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: true } as const

/** A live reset refreshes first pages only, never replays a long cursor chain. */
export async function refreshMemory(cache: QueryClient, boardId: string): Promise<void> {
  const prefix = memoryKey(boardId)
  await cache.cancelQueries({ queryKey: prefix })
  cache.setQueriesData<InfiniteData<MemoryPage<unknown>, string | null>>({
    queryKey: prefix,
    predicate: (query) => query.queryKey[3] === 'cards' || query.queryKey[3] === 'notes' || query.queryKey[3] === 'history' || query.queryKey[3] === 'bindings' || query.queryKey[3] === 'claims',
  }, (current) => current ? { ...current, pages: current.pages.slice(0, 1), pageParams: [null] } : current)
  await cache.invalidateQueries({ queryKey: prefix, refetchType: 'active' })
}

function scopedSnapshot(next: MemoryBoardView, boardId: string, current?: MemoryBoardView): MemoryBoardView {
  if (next.board.id !== boardId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Memory belongs to another board.' })
  return current && (next.board.revision < current.board.revision || next.sequence < current.sequence) ? current : next
}
function newestPage<T>(cache: QueryClient, key: readonly unknown[], cursor: string | null, next: MemoryPage<T>): MemoryPage<T> {
  const current = cache.getQueryData<InfiniteData<MemoryPage<T>, string | null>>(key)
  const index = current?.pageParams.indexOf(cursor) ?? -1
  const previous = index >= 0 ? current?.pages[index] : undefined
  return previous && previous.revision > next.revision ? previous : next
}
function useCursorRecovery(error: unknown, cache: QueryClient, boardId: string) {
  const handled = useRef<unknown>(undefined)
  useEffect(() => {
    if (!ApiError.is(error) || error.code !== 'CURSOR_STALE' || handled.current === error) return
    handled.current = error
    void refreshMemory(cache, boardId)
  }, [error, cache, boardId])
}

/** onChange sees each new committed change once, as it arrives on the live stream. */
export function useMemoryBoard(client: MemoryBoardClient, scope: MemoryBoardScope, onChange?: (change: MemoryChange) => void) {
  const cache = useQueryClient()
  const changed = useRef(onChange)
  changed.current = onChange
  const identity = useQuery({ ...quiet, queryKey: ['memory-board-scope', sessionGeneration(), scope], queryFn: ({ signal }) => client.resolve(scope, signal) })
  const boardId = identity.data?.id
  const [registration, setRegistration] = useState<{ boardId: string; connection: MemoryConnection; ready: boolean }>()
  const sequence = useRef<{ boardId?: string; snapshot: number; received: number }>({ snapshot: -1, received: -1 })
  const snapshot = useQuery({
    ...quiet, queryKey: memorySnapshotKey(boardId ?? ''), enabled: Boolean(boardId && registration?.boardId === boardId && registration.ready),
    queryFn: async ({ signal }) => {
      const id = boardId!
      return scopedSnapshot(await client.readBoard(id, signal), id, cache.getQueryData<MemoryBoardView>(memorySnapshotKey(id)))
    },
  })
  useEffect(() => {
    if (!boardId) return
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    sequence.current = { boardId, snapshot: -1, received: -1 }
    const refresh = () => {
      pending = true
      if (timer || closed) return
      timer = setTimeout(() => {
        timer = undefined
        if (closed || !pending) return
        pending = false
        // Query owns errors and retained data. This promise does not reject by default.
        void refreshMemory(cache, boardId)
      }, 100)
    }
    const stop = client.subscribe(boardId, {
      ready: () => {
        if (closed) return
        setRegistration((old) => ({ boardId, connection: old?.boardId === boardId ? old.connection : 'connecting', ready: true }))
        if (cache.getQueryData(memorySnapshotKey(boardId))) refresh()
      },
      connection: (connection) => {
        if (!closed) setRegistration((old) => ({ boardId, connection, ready: old?.boardId === boardId && old.ready || false }))
      },
      change: (change) => {
        if (closed || change.boardId !== boardId) return
        const tracked = sequence.current
        if (change.sequence <= Math.max(tracked.snapshot, tracked.received)) return
        tracked.received = change.sequence
        changed.current?.(change)
        // Both gaps and consecutive events reconcile via one bounded, coalesced read.
        refresh()
      },
      reset: refresh,
    })
    return () => { closed = true; clearTimeout(timer); stop() }
  }, [boardId, cache, client])
  useEffect(() => {
    if (snapshot.data && sequence.current.boardId === snapshot.data.board.id) {
      sequence.current.snapshot = Math.max(sequence.current.snapshot, snapshot.data.sequence)
    }
  }, [snapshot.data])
  return {
    identity, snapshot, boardId,
    connection: registration && registration.boardId === boardId ? registration.connection : 'connecting' as MemoryConnection,
    retry: () => boardId ? refreshMemory(cache, boardId) : identity.refetch(),
  }
}

export function useMemoryCards(client: MemoryBoardClient, board: MemoryBoardView, filter: CardFilter, enabled: boolean) {
  const cache = useQueryClient(), key = [...memoryKey(board.board.id), 'cards', filter]
  const initial = !filter.query && filter.status !== 'done' && !filter.completionKind
    ? board.openColumns.find((column) => column.status === filter.status) : undefined
  const result = useInfiniteQuery({
    ...quiet, queryKey: key, enabled,
    initialPageParam: null as string | null,
    initialData: initial ? { pages: [initial], pageParams: [null] } : undefined,
    queryFn: async ({ pageParam, signal }) => newestPage(cache, key, pageParam,
      await client.readCards(board.board.id, filter, { cursor: pageParam ?? undefined, signal })),
    getNextPageParam: (last) => last.hasMore ? last.nextCursor : undefined,
  })
  useCursorRecovery(result.error, cache, board.board.id)
  return { ...result, restart: () => refreshMemory(cache, board.board.id) }
}
export function useMemoryNotes(client: MemoryBoardClient, board: MemoryBoardView, archived: boolean) {
  const cache = useQueryClient(), key = [...memoryKey(board.board.id), 'notes', archived]
  const result = useInfiniteQuery({
    ...quiet, queryKey: key,
    initialPageParam: null as string | null,
    initialData: !archived ? { pages: [board.notes], pageParams: [null] } : undefined,
    queryFn: async ({ pageParam, signal }) => newestPage(cache, key, pageParam,
      await client.readNotes(board.board.id, archived, { cursor: pageParam ?? undefined, signal })),
    getNextPageParam: (last) => last.hasMore ? last.nextCursor : undefined,
  })
  useCursorRecovery(result.error, cache, board.board.id)
  return { ...result, restart: () => refreshMemory(cache, board.board.id) }
}
export function useMemoryCardDetail(client: MemoryBoardClient, boardId: string, cardId: string) {
  const cache = useQueryClient(), key = [...memoryKey(boardId), 'card', cardId]
  return useQuery({
    ...quiet, queryKey: key,
    queryFn: async ({ signal }) => {
      const next = await client.readCard(boardId, cardId, { signal })
      if (next.card.boardId !== boardId || next.card.id !== cardId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'This card response does not match the selected card.' })
      }
      const current = cache.getQueryData<MemoryCardDetail>(key)
      return current && current.card.revision > next.card.revision ? current : next
    },
  })
}
export function useMemoryHistory(client: MemoryBoardClient, detail: MemoryCardDetail, enabled: boolean) {
  const cache = useQueryClient(), key = [...memoryKey(detail.card.boardId), 'history', detail.card.id]
  const result = useInfiniteQuery({
    ...quiet, queryKey: key, enabled,
    initialPageParam: null as string | null,
    initialData: { pages: [detail.history], pageParams: [null] },
    queryFn: async ({ pageParam, signal }) => newestPage(cache, key, pageParam,
      (await client.readCard(detail.card.boardId, detail.card.id, { cursor: pageParam ?? undefined, signal })).history),
    getNextPageParam: (last) => last.hasMore ? last.nextCursor : undefined,
  })
  useCursorRecovery(result.error, cache, detail.card.boardId)
  return { ...result, restart: () => refreshMemory(cache, detail.card.boardId) }
}
export function mergedMemoryItems<T extends MemoryCard | MemoryNote>(pages: MemoryPage<T>[] | undefined): T[] {
  const found = new Map<string, T>()
  for (const page of pages ?? []) for (const item of page.items) {
    const previous = found.get(item.id)
    if (!previous || item.revision > previous.revision) found.set(item.id, item)
  }
  return [...found.values()]
}

function useMemoryWorkPages<T>(detail: MemoryCardDetail, kind: 'bindings' | 'claims', initial: MemoryPage<T>,
  read: (boardId: string, cardId: string, options: { cursor?: string; signal: AbortSignal }) => Promise<MemoryPage<T>>) {
  const cache = useQueryClient()
  const result = useInfiniteQuery({
    ...quiet, queryKey: [...memoryKey(detail.card.boardId), kind, detail.card.id, initial.revision],
    initialPageParam: null as string | null,
    initialData: { pages: [initial], pageParams: [null] },
    queryFn: ({ pageParam, signal }) => read(detail.card.boardId, detail.card.id,
      { ...(pageParam ? { cursor: pageParam } : {}), signal }),
    getNextPageParam: last => last.hasMore ? last.nextCursor : undefined,
  })
  useCursorRecovery(result.error, cache, detail.card.boardId)
  return result
}
export function useMemoryBindings(client: MemoryBoardClient, detail: MemoryCardDetail) {
  return useMemoryWorkPages(detail, 'bindings', { items: detail.bindings, ...detail.bindingPage }, client.readBindings)
}
export function useMemoryClaims(client: MemoryBoardClient, detail: MemoryCardDetail) {
  return useMemoryWorkPages(detail, 'claims', { items: detail.claims, ...detail.claimPage }, client.readClaims)
}
