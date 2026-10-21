import { RUNTIME_INSTALLATION_HEADER } from '@foreman-code/contracts'
import { identityChangedEvent, identityEpochKey, rotateProtectedSession } from './protectedChatStorage'
import { rotateSessionController, sessionControllerSignal } from './sessionController'

/** A document-lifetime boundary. Old requests cannot enter a different app instance. */
let generation = 0
let switching = false
let installation: { id: string; generation: number } | undefined

export class SessionChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Operator access changed. Reload this view before continuing.', options)
    this.name = 'AbortError'
  }
}

export function documentInstallationId(): string | undefined {
  return installation?.generation === generation ? installation.id : undefined
}
export function bindDocumentInstallation(id: string): boolean {
  const previous = documentInstallationId()
  if (previous && previous !== id) return false
  installation = { id, generation }
  return true
}

export function installationHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input)
  const id = documentInstallationId()
  if (id) headers.set(RUNTIME_INSTALLATION_HEADER, id)
  return headers
}
export function reloadChangedInstallation(code: string): void {
  if (code !== 'INSTALLATION_CHANGED') return
  beginSessionChange()
  if (typeof window !== 'undefined') window.location.reload()
}

export function sessionGeneration(): number { return generation }
export function assertSession(expected: number): void {
  if (expected !== generation) throw new SessionChangedError()
}
export function sessionSignal(): AbortSignal { return sessionControllerSignal() }
export function sessionIsSwitching(): boolean { return switching }

export function beginSessionChange(): number {
  switching = true
  rotateProtectedSession()
  rotateSessionController(new SessionChangedError())
  return ++generation
}

export function finishSessionChange(): void {
  rotateSessionController(new SessionChangedError())
  ++generation
  switching = false
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== identityEpochKey || event.oldValue === event.newValue) return
  switching = true
  rotateSessionController(new SessionChangedError())
  ++generation
  window.dispatchEvent(new Event(identityChangedEvent))
  // A different app instance must not receive drafts or requests from this document.
  window.location.reload()
})
