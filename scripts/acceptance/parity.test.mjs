import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parity } from './parity.mjs'

// Isolated probe-logic tests. These fakes are never used by local.mjs/service.mjs.
async function fixture(work, { mismatch = false, revokeFails = false } = {}) {
  const originalFetch = globalThis.fetch
  const revoked = [], issued = [], commands = [], transports = []
  const workspace = { workspace: { id: 'ws-demo', description: 'demo' }, revision: 0, archivedAt: null,
    executionLocation: null, locationRevision: 1, locationValidation: { status: 'ready', checkedAt: 'http-time' } }
  const version = { version: { executionSemanticsVersion: 3, id: 'version-demo' } }
  let receipt
  const denial = { error: { code: 'ACCESS_DENIED' } }
  const access = {
    async issue(input) {
      const id = `principal-${issued.length}`; issued.push({ id, input })
      return { principal: { id }, token: `test-only-${id}` }
    },
    async revoke(id) { revoked.push(id); return !revokeFails },
  }
  class Transport { constructor(url, options) { this.url = url; this.options = options } }
  const ProtocolErrorCode = { InvalidParams: -32602 }
  class ProtocolError extends Error {
    constructor(code) { super('MCP protocol rejection'); this.code = code }
  }
  class Client {
    async connect(transport) { this.token = await transport.options.authProvider.token(); transports.push(transport.url.pathname) }
    async close() {}
    async listTools() { return { tools: this.token.endsWith('principal-1') ? []
      : ['workspace_get', 'workspace_update', 'workflow_saved_get_v3'].map((name) => ({ name })) } }
    async callTool(request) {
      commands.push(request)
      if (this.token.endsWith('principal-1')) throw new ProtocolError(ProtocolErrorCode.InvalidParams)
      if (request.name === 'workspace_get') return { structuredContent: { ...workspace,
        locationValidation: { status: 'ready', checkedAt: 'mcp-time' } } }
      if (request.name === 'workspace_update') return { structuredContent: { value: { ...structuredClone(receipt),
        locationValidation: { status: 'ready', checkedAt: 'replay-time' } }, replayed: true } }
      if (request.name === 'workflow_saved_get_v3') return { structuredContent: mismatch ? { incompatible: true } : version }
      throw new Error('Unexpected tool')
    }
  }
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.origin, undefined)
    if (options.headers.authorization.endsWith('principal-1')) return new Response(JSON.stringify(denial), { status: 403 })
    let result = workspace
    if (options.method === 'PATCH') {
      const command = JSON.parse(options.body)
      assert.equal(command.expectedRevision, 0); assert.equal(command.workspaceId, 'ws-demo')
      workspace.revision++; receipt = structuredClone(workspace); result = { value: receipt, replayed: false }
    }
    if (new URL(url).pathname.endsWith('/definition')) result = version
    return new Response(JSON.stringify(result), { status: 200 })
  }
  try { await work({ args: { apiUrl: 'http://127.0.0.1:3307', workspaceId: 'ws-demo',
    workflowIds: [{ workflowId: 'wf-demo' }], access, Client, StreamableHTTPClientTransport: Transport,
    ProtocolError, ProtocolErrorCode }, revoked, issued, commands, transports, workspace }) }
  finally { globalThis.fetch = originalFetch }
}
test('parity uses the same scoped principal, checks read/write denials and revokes all ephemeral credentials', async () => {
  await fixture(async ({ args, revoked, issued, commands, transports, workspace }) => {
    const result = await parity(args)
    assert.deepEqual(result, { comparisons: 3, deniedTransports: 2, deniedOperations: 4, mutationReplayed: true })
    assert.equal(workspace.revision, 1)
    assert.deepEqual(revoked, ['principal-0', 'principal-1'])
    assert.deepEqual(transports, ['/mcp', '/mcp'])
    assert.deepEqual(issued[0].input.grants[0].scope, { workspaceIds: ['ws-demo'] })
    assert.deepEqual(issued[1].input.grants, [{ actions: ['capabilities:read'], scope: {} }])
    assert.equal(issued[0].input.grants[0].actions.includes('runs:start'), false)
    assert.equal(commands.some((command) => command.name === 'run_start'), false)
    assert.equal(JSON.stringify(result).includes('test-only-'), false)
  })
})
test('a transport mismatch fails closed and still revokes issued credentials', async () => {
  await fixture(async ({ args, revoked }) => {
    await assert.rejects(parity(args), { code: 'HTTP_MCP_MISMATCH' })
    assert.deepEqual(revoked, ['principal-0', 'principal-1'])
  }, { mismatch: true })
})
test('revocation failure cannot be reported as successful parity', async () => {
  await fixture(async ({ args }) => {
    await assert.rejects(parity(args), { code: 'PARITY_REVOCATION_FAILED' })
  }, { revokeFails: true })
})
