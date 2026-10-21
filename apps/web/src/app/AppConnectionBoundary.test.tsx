import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { settingsExperienceKeys } from '../shared/api/settingsExperience'
import { AppConnectionBoundary } from './AppConnectionBoundary'

let client: QueryClient
let status: number
let networkFailure: boolean
let errorCode: string
const message = 'Could not verify the local browser connection. Try again in a moment.'

beforeEach(() => {
  status = 200
  networkFailure = false
  errorCode = 'LOCAL_CLIENT_UNAVAILABLE'
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  server.use(http.get('/api/local-human', () => networkFailure ? HttpResponse.error() : status === 200
    ? HttpResponse.json({ principal: { id: 'owner', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions: ['settings:read'], scope: {} }] } })
    : HttpResponse.json({ error: { code: status >= 500 ? errorCode : 'LOCAL_HUMAN_REQUIRED',
      message, details: { retryable: status === 503 } } }, { status })))
})
afterEach(() => client.clear())

function mount() {
  render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <input aria-label="Server draft" defaultValue="" />
  </AppConnectionBoundary></QueryClientProvider>)
}

describe('browser peer verification', () => {
  it.each(['LOCAL_CLIENT_UNAVAILABLE', 'SESSION_CHECK_FAILED', 'network'])('keeps the mounted app through %s', async failure => {
    mount()
    const draft = await screen.findByRole('textbox', { name: 'Server draft' })
    fireEvent.change(draft, { target: { value: 'unsaved server settings' } })
    status = 503
    errorCode = failure
    networkFailure = failure === 'network'
    await act(async () => { await client.invalidateQueries({ queryKey: settingsExperienceKeys.access(), exact: true }) })
    expect(await screen.findByRole('alert', { name: 'Server connection' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(draft).not.toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Server draft' })).toBe(draft)
    expect(draft).toHaveValue('unsaved server settings')
    expect(screen.queryByRole('heading', { name: 'Cannot reach the server' })).not.toBeInTheDocument()
    status = 200
    networkFailure = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Server draft' })).toBe(draft)
    expect(draft).toHaveValue('unsaved server settings')
  })

  it('requires successful initial verification before mounting the app', async () => {
    status = 503
    mount()
    expect(await screen.findByRole('heading', { name: 'Cannot reach the server' })).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    status = 200
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('textbox')).toBeInTheDocument()
  })

  it.each([401, 403])('still removes the app on a definite %s denial', async deniedStatus => {
    mount()
    await screen.findByRole('textbox')
    status = deniedStatus
    await act(async () => { await client.invalidateQueries({ queryKey: settingsExperienceKeys.access(), exact: true }) })
    expect(await screen.findByRole('heading', { name: 'Access unavailable' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
