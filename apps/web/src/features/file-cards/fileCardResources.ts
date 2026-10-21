import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { fileStateAt, type File, type FileState } from '@foreman-code/contracts/files'
import { ApiError } from '../../shared/api/client'

/** Derived state, not a second cache of the server DTO. Wake at the actual expiry and on resume. */
export function useEffectiveFileState(file: File): FileState {
  const subscribe = useCallback((notify: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const check = () => {
      if (disposed) return
      if (timer !== undefined) clearTimeout(timer)
      notify()
      if ('expiresAt' in file && file.state !== 'removed' && file.state !== 'expired') {
        const remaining = Date.parse(file.expiresAt) - Date.now()
        if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
      }
    }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [file])
  const snapshot = useCallback(() => fileStateAt(file, new Date().toISOString()), [file])
  return useSyncExternalStore(subscribe, snapshot, () => file.state)
}

export function useAborted(signal: AbortSignal): boolean {
  const subscribe = useCallback((notify: () => void) => {
    signal.addEventListener('abort', notify)
    return () => signal.removeEventListener('abort', notify)
  }, [signal])
  return useSyncExternalStore(subscribe, () => signal.aborted, () => true)
}

/** This local state is a view-owned browser resource, never a copy of query/server state. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [resource, setResource] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setResource({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  // A changed pin must not display the previous effect's URL even for one render.
  return resource?.blob === blob ? resource?.url : undefined
}

export type FileCardStatus = FileState | 'unavailable'

export function fileErrorStatus(error: unknown): Exclude<FileCardStatus, 'ready'> | undefined {
  if (!ApiError.is(error)) return undefined
  switch (error.code) {
    case 'FILE_EXPIRED': return 'expired'
    case 'FILE_REMOVED': return 'removed'
    case 'FILE_NOT_READY': return 'pending'
    case 'FILE_NOT_FOUND':
    case 'FILE_ACCESS_DENIED': return 'unavailable'
    default: return [401, 403, 404, 410].includes(error.status) ? 'unavailable' : undefined
  }
}

/** Keep the URL alive beyond the click task; cleanup is also safe on unmount/repeated calls. */
export function saveBlob(blob: Blob, filename: string): () => void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    URL.revokeObjectURL(url)
  }
  const timer = setTimeout(dispose, 1_000)
  // The contract rejects paths/controls. Also suppress bidi filename spoofing in the save dialog.
  anchor.download = filename.replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  anchor.href = url
  anchor.rel = 'noopener noreferrer'
  anchor.hidden = true
  document.body.append(anchor)
  try { anchor.click() } catch (error) { dispose(); throw error } finally { anchor.remove() }
  return dispose
}
