import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { DomainError } from '../errors.js'

/** A total budget per validation, not a fresh timeout for every filesystem call. */
export const FILESYSTEM_VALIDATION_TIMEOUT_MS = 5_000
export type FilesystemCheck = <T>(operation: () => Promise<T>) => Promise<T>

/**
 * Filesystem promises cannot interrupt a blocked kernel lookup. Race only the
 * read itself, observe its eventual rejection, and never continue the validation
 * or launch pipeline after cancellation. Callers can release locks/ownership.
 */
export async function withFilesystemDeadline<T>(
  operation: (check: FilesystemCheck) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = FILESYSTEM_VALIDATION_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted()
  const timeout = new AbortController()
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const expired = () => new DomainError('WORKSPACE_LOCATION_TIMEOUT', 'The runner filesystem did not respond before the validation deadline.', 504)
  const deadline = performance.now() + timeoutMs
  const timer = setTimeout(() => timeout.abort(expired()), timeoutMs)
  const enforceDeadline = () => {
    if (performance.now() >= deadline && !timeout.signal.aborted) timeout.abort(expired())
  }
  const check: FilesystemCheck = <V>(read: () => Promise<V>) => {
    enforceDeadline()
    return new Promise<V>((resolveValue, reject) => {
      const cleanup = () => combined.removeEventListener('abort', abort)
      const abort = () => { cleanup(); reject(combined.reason) }
      if (combined.aborted) { abort(); return }
      combined.addEventListener('abort', abort, { once: true })
      try {
        void read().then(
          (value) => {
            enforceDeadline()
            cleanup()
            if (combined.aborted) reject(combined.reason)
            else resolveValue(value)
          },
          (error: unknown) => { cleanup(); reject(error) },
        )
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
  try {
    const result = await operation(check)
    enforceDeadline()
    combined.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** A name beginning with two dots is not a parent segment (for example ..scratch). */
export function pathsOverlap(left: string, right: string): boolean {
  return [relative(left, right), relative(right, left)].some((value) =>
    value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)))
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/** Canonicalize existing ancestors even when managed runtime storage is not created yet. */
export async function canonicalRuntimePath(root: string, check: FilesystemCheck): Promise<string> {
  let candidate = resolve(root)
  const suffix: string[] = []
  for (;;) {
    try {
      return resolve(await check(() => realpath(candidate)), ...suffix)
    } catch (error) {
      if (!isMissing(error)) throw error
      // A dangling symlink is not a safely missing directory. Fail closed rather
      // than treating an unresolved target as a disjoint lexical path.
      let missing = false
      try { await check(() => lstat(candidate)) } catch (statError) {
        if (!isMissing(statError)) throw statError
        missing = true
      }
      if (!missing || dirname(candidate) === candidate) throw error
      suffix.unshift(basename(candidate))
      candidate = dirname(candidate)
    }
  }
}
