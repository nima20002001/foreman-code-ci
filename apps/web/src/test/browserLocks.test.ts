import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserLocks } from './browserLocks'

const browserNavigator = navigator
const originalLocks = Object.getOwnPropertyDescriptor(browserNavigator, 'locks')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalLocks) Object.defineProperty(browserNavigator, 'locks', originalLocks)
  else Reflect.deleteProperty(browserNavigator, 'locks')
})

it('keeps browser connectivity and identity when installing Web Locks', async () => {
  const online = navigator.onLine
  const userAgent = navigator.userAgent
  installBrowserLocks()

  expect(navigator.onLine).toBe(online)
  expect(navigator.userAgent).toBe(userAgent)
  expect(navigator).toBe(browserNavigator)
  await expect(navigator.locks.request('editor-command', lock => lock?.name)).resolves.toBe('editor-command')
})

it('reads changes to native connectivity after installation', () => {
  installBrowserLocks()
  vi.spyOn(browserNavigator, 'onLine', 'get').mockReturnValue(false)

  expect(navigator.onLine).toBe(false)
})

it('preserves native methods and restores the original locks', () => {
  const expected = browserNavigator.javaEnabled()
  const restore = installBrowserLocks()

  expect(navigator.javaEnabled()).toBe(expected)
  restore()
  expect(navigator).toBe(browserNavigator)
  expect(Object.getOwnPropertyDescriptor(navigator, 'locks')).toEqual(originalLocks)
})
