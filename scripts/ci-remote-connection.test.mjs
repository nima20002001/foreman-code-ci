import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awaitTickets, mcpClient, workspaceFor } from './ci-remote.mjs'

function environment(t, values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function directory(t) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-connection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

async function endpoint(t, handle) {
  const calls = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const message = JSON.parse(text)
    calls.push({ message, authorization: request.headers.authorization })
    if (message.method === 'initialize') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-11-25' } }))
      return
    }
    const result = handle(message, response)
    if (result === undefined) return
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}

function operatorEnvironment(t, url) {
  environment(t, { FOREMAN_CODE_MAIN_URL: url, FOREMAN_CODE_OPERATOR_TOKEN: 'operator-fixture',
    FOREMAN_CODE_MCP_TOKEN: undefined, GRAPHQL_MCP_TOKEN: undefined })
}

const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test('replays accepted CI admission unchanged after a lost response', async t => {
  const receipts = new Map()
  let admissions = 0
  const server = await endpoint(t, (message, response) => {
    const { name, arguments: input } = message.params
    if (name === 'ci_run') {
      if (!receipts.has(input.commandId)) {
        admissions++
        receipts.set(input.commandId, { ticketId: 'ticket-one' })
      }
      if (server.calls.filter(call => call.message.params?.name === name).length === 1) {
        response.destroy()
        return
      }
      return toolResult(receipts.get(input.commandId))
    }
    assert.fail(`Unexpected tool ${name}`)
  })
  operatorEnvironment(t, server.url)
  const call = await mcpClient()
  const input = { workspaceId: 'workspace', suite: 'unit', commit: 'a'.repeat(40),
    scope: 'full', commandId: 'retained-command' }
  const started = await call('ci_run', input)
  assert.equal(started.ticketId, 'ticket-one')
  assert.equal(admissions, 1)
  const attempts = server.calls.filter(call => call.message.params?.name === 'ci_run')
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0].message.params.arguments, input)
  assert.deepEqual(attempts[1].message.params.arguments, input)
})

test('resumes an interrupted CI ticket read', async t => {
  let reads = 0
  const server = await endpoint(t, (message, response) => {
    assert.equal(message.params.name, 'ci_get')
    assert.equal(message.params.arguments.ticketId, 'ticket-one')
    if (++reads === 1) {
      response.destroy()
      return
    }
    return toolResult({ run: { id: 'ticket-one', suite: 'unit', state: 'passed' },
      wait: { status: 'settled' } })
  })
  operatorEnvironment(t, server.url)
  const call = await mcpClient()
  const runs = await awaitTickets(call, 'workspace', ['ticket-one'])
  assert.equal(runs[0].state, 'passed')
  assert.equal(reads, 2)
})

test('does not retry a denied CI admission', async t => {
  const server = await endpoint(t, () => ({ isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'ACCESS_DENIED' } }) }] }))
  operatorEnvironment(t, server.url)
  const call = await mcpClient()
  await assert.rejects(call('ci_run', { commandId: 'denied-command' }), /ACCESS_DENIED/)
  assert.equal(server.calls.filter(call => call.message.method === 'tools/call').length, 1)
})

test('discovers a repository workspace on a later page', async t => {
  const root = directory(t)
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/project.git'])
  const cwd = process.cwd()
  process.chdir(root)
  t.after(() => process.chdir(cwd))
  environment(t, { FOREMAN_CODE_WORKSPACE_ID: undefined })
  const lists = []
  const call = async (name, input) => {
    if (name === 'workspace_list') {
      lists.push(input)
      return input.cursor === 'later-page'
        ? { items: [{ workspace: { id: 'matching' } }], pageInfo: { nextCursor: null } }
        : { items: [{ workspace: { id: 'other' } }], pageInfo: { nextCursor: 'later-page' } }
    }
    assert.equal(name, 'workspace_get')
    return { workspace: { repository: { owner: 'example', name: input.workspaceId === 'matching' ? 'project' : 'other' } } }
  }
  assert.equal(await workspaceFor(call), 'matching')
  assert.deepEqual(lists, [{}, { cursor: 'later-page' }])
})

for (const tokenName of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN']) {
  test(`uses the admitted scoped bridge with ${tokenName} instead of Operator credentials`, async t => {
    const root = directory(t)
    copyFileSync(new URL('./graphql-mcp.mjs', import.meta.url), join(root, 'launcher.mjs'))
    mkdirSync(join(root, 'routes'))
    const server = await endpoint(t, message => {
      assert.equal(message.params.name, 'ci_get')
      return toolResult({ run: { id: 'scoped-ticket', state: 'passed' } })
    })
    const token = 'scoped-fixture'
    writeFileSync(join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
      JSON.stringify({ endpoint: `${server.url}/mcp`, pid: process.pid,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), toolTimeoutMs: 300_000 }))
    environment(t, { FOREMAN_CODE_APP_MCP_DIRECTORY: root, GRAPHQL_APP_MCP_DIRECTORY: undefined,
      FOREMAN_CODE_MCP_TOKEN: undefined, GRAPHQL_MCP_TOKEN: undefined, [tokenName]: token,
      FOREMAN_CODE_OPERATOR_TOKEN: 'unrelated-operator', FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9' })
    const call = await mcpClient()
    assert.deepEqual(await call('ci_get', { ticketId: 'scoped-ticket' }),
      { run: { id: 'scoped-ticket', state: 'passed' } })
    assert.equal(server.calls.length, 2)
    assert.ok(server.calls.every(call => call.authorization === `Bearer ${token}`))
  })
}

test('finds the delivered scoped bridge when an account changes HOME', async t => {
  const root = directory(t)
  const installed = join(root, 'service', '.local', 'share', 'graphql', 'mcp')
  mkdirSync(join(installed, 'routes'), { recursive: true })
  copyFileSync(new URL('./graphql-mcp.mjs', import.meta.url), join(installed, 'launcher.mjs'))
  const server = await endpoint(t, message => {
    assert.equal(message.params.name, 'ci_get')
    return toolResult({ run: { id: 'account-ticket', state: 'passed' } })
  })
  const token = 'account-scoped-fixture'
  writeFileSync(join(installed, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
    JSON.stringify({ endpoint: `${server.url}/mcp`, pid: process.pid,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), toolTimeoutMs: 300_000 }))
  // Admitted Agents receive the bridge location with their credential; the account's HOME does not locate it.
  environment(t, { HOME: join(root, 'account'), FOREMAN_CODE_MCP_TOKEN: token, GRAPHQL_MCP_TOKEN: undefined,
    FOREMAN_CODE_APP_MCP_DIRECTORY: installed, GRAPHQL_APP_MCP_DIRECTORY: undefined,
    FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9' })
  const call = await mcpClient()
  assert.deepEqual(await call('ci_get', { ticketId: 'account-ticket' }),
    { run: { id: 'account-ticket', state: 'passed' } })
  assert.equal(server.calls.length, 2)
  assert.ok(server.calls.every(call => call.authorization === `Bearer ${token}`))
})

const transientFailures = {
  relay: { error: { code: -32000, message: 'Worker link interrupted',
    data: { kind: 'relay_unavailable', retryable: true, delivery: 'indeterminate' } } },
  tool: { result: { isError: true, ...toolResult({ error: { code: 'DATABASE_BUSY',
    message: 'Retry the same request', details: { retryable: true } } }) } },
}

for (const [kind, failure] of Object.entries(transientFailures)) {
  test(`retries a retryable ${kind} failure after accepted admission with unchanged identity`, async t => {
    const receipts = new Map()
    const server = await endpoint(t, (message, response) => {
      const input = message.params.arguments
      assert.equal(message.params.name, 'ci_run')
      if (!receipts.has(input.commandId)) receipts.set(input.commandId, { ticketId: 'retained-ticket' })
      if (server.calls.filter(call => call.message.method === 'tools/call').length === 1) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...failure }))
        return
      }
      return toolResult(receipts.get(input.commandId))
    })
    operatorEnvironment(t, server.url)
    const call = await mcpClient()
    const input = { workspaceId: 'workspace', suite: 'unit', commit: 'b'.repeat(40),
      scope: 'full', commandId: 'original-command' }
    assert.deepEqual(await call('ci_run', input), { ticketId: 'retained-ticket' })
    assert.equal(receipts.size, 1)
    const attempts = server.calls.filter(call => call.message.method === 'tools/call')
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[0].message, attempts[1].message)
    assert.deepEqual(attempts[1].message.params.arguments, input)
  })

  test(`retains admission arguments when retryable ${kind} failures exhaust retries`, async t => {
    const server = await endpoint(t, (message, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...failure }))
    })
    operatorEnvironment(t, server.url)
    const call = await mcpClient()
    const input = { workspaceId: 'workspace', suite: 'unit', commit: 'c'.repeat(40),
      scope: 'full', commandId: 'exhausted-command' }
    await assert.rejects(call('ci_run', input), error => {
      assert.equal(error.retryable, true)
      assert.ok(error.message.includes(`retry ci_run with the same arguments: ${JSON.stringify(input)}`))
      return true
    })
    const attempts = server.calls.filter(call => call.message.method === 'tools/call')
    assert.equal(attempts.length, 4)
    assert.ok(attempts.every(attempt => JSON.stringify(attempt.message) === JSON.stringify(attempts[0].message)))
  })
}
