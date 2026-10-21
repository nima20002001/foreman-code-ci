import { useSyncExternalStore } from 'react'
import type { Theme } from '@foreman-code/contracts/management'

export const THEME_STORAGE_KEY = 'graphql-theme'

export type { Theme } from '@foreman-code/contracts/management'

const DEFAULT_THEME: Theme = 'dark'
const THEME_CLASSES: readonly string[] = ['theme-dark', 'theme-light']

function isTheme(value: string | null | undefined): value is Theme {
  return value === 'dark' || value === 'light'
}

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(storedTheme) ? storedTheme : null
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
    return null
  }
}

function readDocumentTheme(): Theme | null {
  if (typeof document === 'undefined') return null
  return isTheme(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : null
}

export function getInitialTheme(): Theme {
  return readStoredTheme() ?? readDocumentTheme() ?? DEFAULT_THEME
}

function updateThemeColor(theme: Theme) {
  if (typeof document === 'undefined') return

  const themeColor = theme === 'dark' ? '#111416' : '#f4f4f4'
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', themeColor)
}

export function applyTheme(theme: Theme, persist = false) {
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = theme
    root.classList.remove(...THEME_CLASSES)
    root.classList.add(`theme-${theme}`)
    root.style.colorScheme = theme
    updateThemeColor(theme)
  }

  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // A theme still works for this session when persistence is unavailable.
    }
  }
}

type ThemeListener = () => void
const listeners = new Set<ThemeListener>()
let currentTheme = getInitialTheme()

// The index.html initializer handles the first paint. This keeps direct mounts
// in tests and Storybook-like environments equally deterministic.
applyTheme(currentTheme)

export function initializeTheme(): Theme {
  currentTheme = getInitialTheme()
  applyTheme(currentTheme)
  return currentTheme
}

export function setTheme(theme: Theme) {
  if (theme === currentTheme) {
    applyTheme(theme, true)
    return
  }

  currentTheme = theme
  applyTheme(theme, true)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: ThemeListener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return currentTheme
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_THEME)
}
