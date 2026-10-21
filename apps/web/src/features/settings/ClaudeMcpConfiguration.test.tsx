import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ClaudeMcpConfiguration } from './ClaudeMcpConfiguration'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
function setup(mcpServers = {}) {
  server.use(http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({
    graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3999/mcp' },
  })))
  function Editor() {
    const [value, setValue] = useState({ ...savedClaudeConfiguration, mcpServers })
    return <><ClaudeMcpConfiguration value={value} onChange={setValue} /><output data-testid="draft">{JSON.stringify(value)}</output></>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><Editor /></QueryClientProvider>)
  return userEvent.setup()
}
it('adds the server-supplied app endpoint to the draft without changing permissions or claiming connected health', async () => {
  const user = setup()
  const explanation = 'Claude supports the Foreman Code app MCP connection.'
  expect(screen.queryByText(new RegExp(explanation))).not.toBeInTheDocument()
  await user.hover(screen.getByRole('button', { name: 'About MCP connections' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
  await user.unhover(screen.getByRole('button', { name: 'About MCP connections' }))
  const add = await screen.findByRole('button', { name: 'Add Foreman Code MCP' })
  await waitFor(() => expect(add).toBeEnabled())
  await user.click(add)
  expect(await screen.findByRole('button', { name: 'Foreman Code added' })).toBeDisabled()
  expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual({ ...savedClaudeConfiguration,
    mcpServers: { 'foreman-code': { type: 'http', url: 'http://127.0.0.1:3999/mcp' } } })
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Remove foreman-code' }))
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({})
})
it('rejects secret-bearing endpoints and duplicate names before adding an app HTTP server', async () => {
  const user = setup()
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'foreman-code')
  const endpoint = screen.getByRole('textbox', { name: 'MCP endpoint' })
  await user.type(endpoint, 'https://user:secret@example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('without credentials')
  await user.clear(endpoint); await user.type(endpoint, 'https://example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({ 'foreman-code': { type: 'http', url: 'https://example.com/mcp' } })
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'foreman-code')
  await user.type(endpoint, 'https://other.example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('already configured')
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers['foreman-code'].url).toBe('https://example.com/mcp')
})
it('rejects an external HTTP server before adding unusable tools to the draft', async () => {
  const user = setup()
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'external')
  await user.type(screen.getByRole('textbox', { name: 'MCP endpoint' }), 'https://external.example/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('External MCP servers are not supported')
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({})
})
it('recognizes the supported old app entry and does not add a second canonical connection', async () => {
  const user = setup({ graphql: { type: 'http', url: 'http://127.0.0.1:3999/mcp' } })
  expect(await screen.findByRole('button', { name: 'Foreman Code added' })).toBeDisabled()
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({
    graphql: { type: 'http', url: 'http://127.0.0.1:3999/mcp' },
  })
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'foreman-code')
  await user.type(screen.getByRole('textbox', { name: 'MCP endpoint' }), 'http://127.0.0.1:3999/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Keep one connection')
  expect(Object.keys(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers)).toEqual(['graphql'])
})
