import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ThemeToggle } from './ThemeToggle'
import { setTheme } from './themeStore'

function fixture() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={cache}><ThemeToggle /></QueryClientProvider>)
  return cache
}

it('uses Main’s preference instead of the browser’s divergent saved theme', async () => {
  setTheme('dark')
  server.use(http.get('*/api/management/settings/general', () => HttpResponse.json({
    value: { theme: 'light' }, revision: 3, versionId: 'general-3',
  })))
  fixture()
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeEnabled()
})

it('saves with Main’s revision and applies only the confirmed result', async () => {
  setTheme('dark')
  let submitted: unknown
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  server.use(
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'dark' }, revision: 4, versionId: 'general-4',
    })),
    http.put('*/api/management/settings/general', async ({ request }) => {
      submitted = await request.json()
      await held
      return HttpResponse.json({ value: { value: { theme: 'light' }, revision: 5, versionId: 'general-5' },
        replayed: false })
    }),
  )
  fixture()
  const button = await screen.findByRole('button', { name: 'Switch to light theme' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await waitFor(() => expect(submitted).toMatchObject({ value: { theme: 'light' }, expectedRevision: 4 }))
  expect(button).toBeDisabled()
  expect(document.documentElement.dataset.theme).toBe('dark')
  release()
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
})

it('disables changes when Main’s settings cannot be read', async () => {
  server.use(http.get('*/api/management/settings/general', () => HttpResponse.json({
    error: { code: 'FORBIDDEN', message: 'Settings access denied.' },
  }, { status: 403 })))
  fixture()
  expect(await screen.findByRole('button', { name: /Theme unavailable/ })).toBeDisabled()
})

it('picks up a preference changed by another computer on refresh', async () => {
  let theme = 'dark'
  let revision = 1
  server.use(http.get('*/api/management/settings/general', () => HttpResponse.json({
    value: { theme }, revision, versionId: `general-${revision}`,
  })))
  const cache = fixture()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeEnabled())
  theme = 'light'
  revision = 2
  await cache.invalidateQueries({ queryKey: ['general-settings'] })
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
})

it.each(['network', 'invalid-response'])('keeps an uncertain save’s command identity after %s failure', async failure => {
  setTheme('dark')
  const writes: unknown[] = []
  server.use(
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'dark' }, revision: 0, versionId: null,
    })),
    http.put('*/api/management/settings/general', async ({ request }) => {
      writes.push(await request.json())
      if (writes.length === 1) return failure === 'network' ? HttpResponse.error() : HttpResponse.json({})
      return HttpResponse.json({ value: { value: { theme: 'light' }, revision: 1, versionId: 'general-1' },
        replayed: true })
    }),
  )
  const cache = fixture()
  const button = screen.getByRole('button', { name: 'Switch to light theme' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  const retry = await screen.findByRole('button', { name: 'Retry theme save' })
  await act(async () => { await cache.invalidateQueries({ queryKey: ['general-settings'] }) })
  expect(button).toBeDisabled()
  await userEvent.click(retry)
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
})

it('retains a newer confirmed theme when an earlier save reply arrives late', async () => {
  setTheme('dark')
  let release!: () => void
  let revision = 0
  const held = new Promise<void>(resolve => { release = resolve })
  server.use(
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'dark' }, revision, versionId: revision ? `general-${revision}` : null,
    })),
    http.put('*/api/management/settings/general', async () => {
      await held
      return HttpResponse.json({ value: { value: { theme: 'light' }, revision: 1, versionId: 'general-1' },
        replayed: false })
    }),
  )
  const cache = fixture()
  const button = screen.getByRole('button', { name: 'Switch to light theme' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  revision = 2
  await cache.invalidateQueries({ queryKey: ['general-settings'] })
  release()
  await waitFor(() => expect(button).toBeEnabled())
  expect(document.documentElement.dataset.theme).toBe('dark')
})


it('unlocks a rejected theme change after a successful background read', async () => {
  setTheme('dark')
  server.use(
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'dark' }, revision: 2, versionId: 'general-2',
    })),
    http.put('*/api/management/settings/general', () => HttpResponse.json({
      error: { code: 'REVISION_CONFLICT', message: 'Settings changed.' },
    }, { status: 409 })),
  )
  const cache = fixture()
  const button = await screen.findByRole('button', { name: 'Switch to light theme' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await screen.findByText('Settings changed.')
  expect(button).toBeDisabled()
  await act(async () => { await cache.invalidateQueries({ queryKey: ['general-settings'] }) })
  await waitFor(() => expect(button).toBeEnabled())
  expect(screen.queryByText('Settings changed.')).not.toBeInTheDocument()
})
