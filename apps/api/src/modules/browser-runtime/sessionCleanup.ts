import { DomainError } from '../errors.js'
import type { BrowserMediaService } from './media.js'
import type { BrowserFileStore } from './files.js'

/** The canonical lifecycle owner fences files even while native capture retirement remains uncertain. */
export function createBrowserSessionCleanup(media: BrowserMediaService, files: BrowserFileStore,
  reportFailure: (error: unknown) => void): (sessionId: string) => Promise<void> {
  return async sessionId => {
    const results = await Promise.allSettled([media.closeSession(sessionId), files.closeSession(sessionId)])
    for (const result of results) if (result.status === 'rejected') reportFailure(result.reason)
    if (results.some(result => result.status === 'rejected')) {
      throw new DomainError('BROWSER_CLEANUP_PENDING', 'Browser session resource cleanup is still pending.', 503)
    }
  }
}
