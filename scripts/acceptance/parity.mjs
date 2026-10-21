import { decodeMcpToolResult } from '../../packages/contracts/dist/operatorMcp.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

function check(value, code) { if (!value) throw Object.assign(new Error('Acceptance check failed.'), { code }) }
function payload(result) {
  check(!result.isError, 'MCP_READ_FAILED')
  return decodeMcpToolResult(result)
}
function stableWorkspace(item) {
  return { workspace: item.workspace, revision: item.revision, archivedAt: item.archivedAt,
    executionLocation: item.executionLocation, locationRevision: item.locationRevision,
    locationStatus: item.locationValidation.status }
}
/** Real network transports. Tokens exist only in this function and hashed DB rows.
 * Never returns tokens or response bodies to the launcher; revokes both in finally. */
export async function parity({ apiUrl, workspaceId, workflowIds, runId, access, Client, StreamableHTTPClientTransport,
  ProtocolError, ProtocolErrorCode }) {
  const principals = [], clients = []
  let comparisons = 0
  const issue = async (grants) => {
    const issued = await access.issue({ name: 'ENG07 ephemeral parity', audience: 'operator', grants,
      expiresAt: new Date(Date.now() + 10 * 60_000) })
    principals.push(issued.principal.id)
    const client = new Client({ name: 'eng07-acceptance', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', apiUrl), { authProvider: { token: async () => issued.token } }))
    return { client, token: issued.token }
  }
  try {
    const writer = await issue([{ actions: ['workspaces:read', 'workspaces:update', 'workspace_locations:read',
      'workflows:read', 'graph:read', 'runs:read'], scope: { workspaceIds: [workspaceId] } }])
    const denied = await issue([{ actions: ['capabilities:read'], scope: {} }])
    const deniedCall = async (name, args) => {
      const advertised = await denied.client.listTools()
      check(!advertised.tools.some((tool) => tool.name === name), 'MCP_DENIED_TOOL_ADVERTISED')
      try {
        const result = await denied.client.callTool({ name, arguments: args })
        const text = result.content?.find((part) => part.type === 'text')?.text
        check(result.isError === true && typeof text === 'string', 'MCP_DENIAL_FAILED')
        check(JSON.parse(text).error?.code === 'ACCESS_DENIED', 'MCP_DENIAL_FAILED')
        return
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.InvalidParams) throw error
        return
      }
      check(false, 'MCP_DENIAL_FAILED')
    }
    const http = async (path, method = 'GET', body, token = writer.token) => {
      const response = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000) })
      const value = await response.json()
      return { status: response.status, value }
    }
    const call = async (tool, args) => payload(await writer.client.callTool({ name: tool, arguments: args }))
    const match = (a, b) => { check(isDeepStrictEqual(a, b), 'HTTP_MCP_MISMATCH'); comparisons++ }
    const base = `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
    const original = await http(base)
    check(original.status === 200, 'HTTP_READ_FAILED')
    match(stableWorkspace(original.value), stableWorkspace(await call('workspace_get', { workspaceId })))
    // Exercise an actual idempotent write across transports, without changing
    // executable definitions, Agents, approvals, locations or accepting a Run.
    const command = { workspaceId, commandId: randomUUID(), expectedRevision: original.value.revision,
      description: original.value.workspace.description ?? '' }
    const written = await http(base, 'PATCH', command)
    check(written.status === 200 && written.value.replayed === false, 'HTTP_WRITE_FAILED')
    const replay = await call('workspace_update', command)
    check(replay.replayed === true, 'MCP_REPLAY_FAILED')
    // Folder validation is a live probe; its checkedAt is not a command fact.
    match(stableWorkspace(written.value.value), stableWorkspace(replay.value))
    const refreshed = await http(base)
    check(refreshed.value.revision === original.value.revision + 1, 'PARITY_DUPLICATE_MUTATION')
    const refused = await http(base, 'GET', undefined, denied.token)
    check(refused.status === 403 && refused.value.error?.code === 'ACCESS_DENIED', 'HTTP_DENIAL_FAILED')
    await deniedCall('workspace_get', { workspaceId })
    const deniedWrite = await http(base, 'PATCH', command, denied.token)
    check(deniedWrite.status === 403 && deniedWrite.value.error?.code === 'ACCESS_DENIED', 'HTTP_WRITE_DENIAL_FAILED')
    await deniedCall('workspace_update', command)
    check((await http(base)).value.revision === refreshed.value.revision, 'DENIED_MUTATION_APPLIED')
    for (const { workflowId } of workflowIds) {
      const result = await http(`${base}/workflows/${encodeURIComponent(workflowId)}/definition`)
      check(result.status === 200, 'HTTP_READ_FAILED')
      match(result.value, await call('workflow_saved_get_v3', { workspaceId, workflowId }))
    }
    if (runId) {
      const args = { workspaceId, runId }, path = `${base}/runs/${encodeURIComponent(runId)}`
      const record = await http(`${path}/record`)
      check(record.status === 200, 'HTTP_RUN_READ_FAILED')
      check(record.value.run.executionState === 'completed' && !record.value.cleanupPending, 'SETTLE_RUN_BEFORE_PARITY')
      match(record.value, await call('run_record_get', args))
      const version = await http(`${path}/version`)
      check(version.status === 200, 'HTTP_VERSION_FAILED')
      match(version.value, await call('run_version_get', args))
      let cursor, pages = 0
      const seen = new Set()
      do {
        check(++pages <= 500, 'PARITY_PAGE_BUDGET_EXCEEDED')
        const query = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) })
        const page = await http(`${path}/executions?${query}`)
        check(page.status === 200, 'HTTP_EXECUTIONS_FAILED')
        match(page.value, await call('run_executions_list', { ...args, limit: 25, ...(cursor ? { cursor } : {}) }))
        for (const execution of page.value.items) {
          const detail = await http(`${path}/executions/${encodeURIComponent(execution.executionId)}`)
          check(detail.status === 200, 'HTTP_EXECUTION_FAILED')
          const executionArgs = { ...args, executionId: execution.executionId }
          match(detail.value, await call('run_execution_get', executionArgs))
          let bindingCursor, bindingPages = 0
          const bindingSeen = new Set()
          do {
            check(++bindingPages <= 500, 'PARITY_BINDING_BUDGET_EXCEEDED')
            const bindingQuery = new URLSearchParams({ limit: '25', ...(bindingCursor ? { cursor: bindingCursor } : {}) })
            const bindings = await http(`${path}/executions/${encodeURIComponent(execution.executionId)}/bindings?${bindingQuery}`)
            check(bindings.status === 200, 'HTTP_BINDINGS_FAILED')
            match(bindings.value, await call('run_execution_bindings_list', { ...executionArgs, limit: 25,
              ...(bindingCursor ? { cursor: bindingCursor } : {}) }))
            bindingCursor = bindings.value.pageInfo.nextCursor
            if (bindingCursor) { check(!bindingSeen.has(bindingCursor), 'PARITY_BINDING_CURSOR_STUCK'); bindingSeen.add(bindingCursor) }
          } while (bindingCursor)
        }
        cursor = page.value.pageInfo.nextCursor
        if (cursor) { check(!seen.has(cursor), 'PARITY_CURSOR_DID_NOT_ADVANCE'); seen.add(cursor) }
      } while (cursor)
      // A terminal read that changed during the probe is not consistent evidence.
      match(record.value, (await http(`${path}/record`)).value)
    }
    return { comparisons, deniedTransports: 2, deniedOperations: 4, mutationReplayed: true }
  } finally {
    const closed = await Promise.allSettled(clients.map((client) => client.close()))
    for (const result of closed) {
      if (result.status === 'rejected') diagnosticWarning('close parity client', result.reason, 'PARITY_CLIENT_CLOSE_FAILED')
    }
    // Revocation failure must not be reported as a successful probe.
    await Promise.all(principals.map(async (id) => check(await access.revoke(id), 'PARITY_REVOCATION_FAILED')))
  }
}
import { diagnosticWarning } from '../diagnostic-warning.mjs'
