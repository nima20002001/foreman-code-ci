import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { NodeTelemetryInfo } from './NodeTelemetryInfo'

it('shows an explicit unavailable state and sends no request without an exact selection', async () => {
  let requests = 0
  server.use(http.post('*/api/management/resource-telemetry/read', () => { requests += 1; return HttpResponse.json({}) }))
  const client = new QueryClient()
  await act(async () => {
    render(<QueryClientProvider client={client}><NodeTelemetryInfo /></QueryClientProvider>)
  })
  expect(screen.getByText('Computer and resource use unavailable')).toBeInTheDocument()
  expect(screen.queryByText('0.0%')).toBeNull()
  expect(client.isFetching()).toBe(0)
  expect(requests).toBe(0)
  client.clear()
})
