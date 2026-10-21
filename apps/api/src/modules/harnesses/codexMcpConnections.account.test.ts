import { expect, it, vi } from 'vitest'
import { CodexMcpConnections } from './codexMcpConnections.js'

vi.mock('./codexProtocol.js', () => ({
  qualifyCodex: async (binary: string, _cwd: string, environment: NodeJS.ProcessEnv, authenticated: boolean) => {
    if (environment.FIXTURE_SIGNED_OUT === '1' && authenticated) throw new Error('Codex is signed out')
    return { binary }
  }, assertCodexUnchanged: async () => {},
}))
vi.mock('./process.js', () => ({ runCommand: async (_binary: string, _args: string[], _cwd: string,
  _signal: AbortSignal, environment: NodeJS.ProcessEnv) => ({ exitCode: 0,
  stdout: JSON.stringify([{ name: 'selected', enabled: true, transport: { type: 'streamable_http',
    url: `https://${environment.CODEX_HOME === '/selected/account' ? 'selected' : 'default'}.example/mcp` } }]),
  stderr: '' }) }))
vi.mock('./codexStdioTransport.js', () => ({ CodexStdioTransport: class {
  constructor(_binary: string, _cwd: string, private readonly environment: NodeJS.ProcessEnv) {}
  async start() {}
  async close() {}
  async request() {
    return { layers: [{ name: { type: 'user', file: `${this.environment.CODEX_HOME}/config.toml` },
      version: '1', config: { mcp_servers: { selected: {
        url: `https://${this.environment.CODEX_HOME === '/selected/account' ? 'selected' : 'default'}.example/mcp`,
      } } } }] }
  }
} }))

it('inspects native MCP using the selected account environment for both protocol and CLI reads', async () => {
  const adapter = new CodexMcpConnections('/installed/codex', '/workspace', undefined, async () => {},
    { HOME: '/selected', CODEX_HOME: '/selected/account' })
  const snapshot = await adapter.read(new AbortController().signal)
  expect(snapshot.user.selected).toMatchObject({ url: 'https://selected.example/mcp' })
  expect(snapshot.effective.selected).toMatchObject({ url: 'https://selected.example/mcp' })
})

it('inspects native MCP configuration while Codex is signed out', async () => {
  const adapter = new CodexMcpConnections('/installed/codex', '/workspace', undefined, async () => {},
    { HOME: '/selected', CODEX_HOME: '/selected/account', FIXTURE_SIGNED_OUT: '1' })
  await expect(adapter.read(new AbortController().signal)).resolves.toMatchObject({ harness: 'codex',
    user: { selected: { url: 'https://selected.example/mcp' } } })
})
