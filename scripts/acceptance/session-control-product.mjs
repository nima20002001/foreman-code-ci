import { decodeMcpToolResult } from '../../packages/contracts/dist/operatorMcp.js'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sessionControlHeaders } from './session-control-client.mjs'

/** One local product client for provisioning and preparing the native matrix. */
export async function sessionControlProduct(input) {
  const base = new URL(input.baseUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
  const [contracts, agentChat, management, profiles, placements, workflows, roots, boundLocations] = await Promise.all([
    import('../../packages/contracts/dist/index.js'), import('../../packages/contracts/dist/agentChat.js'),
    import('../../packages/contracts/dist/management/index.js'), import('../../packages/contracts/dist/harnessRegistry.js'),
    import('../../packages/contracts/dist/nodePlacement.js'),
    import('../../packages/contracts/dist/wave25/index.js'),
    import('../../packages/contracts/dist/workspaceRootPolicies.js'),
    import('../../packages/contracts/dist/workspaceBoundLocation.js'),
  ])
  const headers = sessionControlHeaders(input)
  const read = async path => {
    const response = await fetch(new URL(path, base), { headers, credentials: 'omit', signal: AbortSignal.timeout(180000) })
    assert.ok(response.ok, `Product read failed: ${response.status}`)
    return response.json()
  }
  const client = new Client({ name: 'Foreman Code native session controls preparation', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
      authProvider: { token: async () => process.env[input.mcpTokenEnv] },
    }))
    return { contracts, agentChat, management, profiles, placements, workflows, roots, boundLocations,
      read, identity: await read('/health/identity'),
      close: () => client.close(), tool: async (name, args, options = {}) => {
        const result = await client.callTool({ name, arguments: args }, { timeout: 360000, ...options })
        assert.ok(!result.isError, `Product tool ${name} failed.`)
        return decodeMcpToolResult(result)
      } }
  } catch (error) {
    try { await client.close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Product client setup and cleanup failed.', { cause: error }) }
    throw error
  }
}
