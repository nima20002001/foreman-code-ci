import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

import { server } from '../mocks/server'
import { bindMockInstallation, resetTestFixtures } from '../shared/mocks/handlers'
import { useNavigationUiStore } from '../features/workspaces/navigationUiStore'
import { protectedKey } from '../shared/api/protectedChatStorage'

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
}
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

// jsdom has no SVG layout; React Flow edge labels measure text with getBBox.
if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  })
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Ordinary route fixtures model an already-bound installation. Boundary tests
// explicitly exercise first binding, recreation, and unavailable storage.
beforeEach(bindMockInstallation)

afterEach(() => {
  server.resetHandlers()
  resetTestFixtures()
  cleanup()
  const pendingPrefix = protectedKey('outbox', 'agent:')
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (key?.startsWith(pendingPrefix)) localStorage.removeItem(key)
  }
  useNavigationUiStore.getState().reset()
  vi.restoreAllMocks()
})

afterAll(() => server.close())
