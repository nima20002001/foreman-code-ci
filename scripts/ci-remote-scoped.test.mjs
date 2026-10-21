import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appMcpTokenEnvironment, inheritedAgentEnvironment } from '../apps/api/src/modules/harnesses/secrets.ts'

const script = new URL('./ci-remote.mjs', import.meta.url).pathname

function repository(t) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-scoped-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'checkout')
  const origin = join(root, 'origin.git')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'CI Fixture', GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI Fixture', GIT_COMMITTER_EMAIL: 'ci@example.invalid', TMPDIR: root }
  const git = args => execFileSync('git', args, { env, encoding: 'utf8' }).trim()
  git(['init', '--bare', '-q', origin])
  git(['init', '-q', '-b', 'fixture', cwd])
  writeFileSync(join(cwd, 'sample.test.mjs'), '')
  git(['-C', cwd, 'add', '.'])
  git(['-C', cwd, 'commit', '-qm', 'fixture'])
  git(['-C', cwd, 'remote', 'add', 'origin', origin])
  return { root, cwd, env, commit: git(['-C', cwd, 'rev-parse', 'HEAD']) }
}

async function endpoint(t, audience, expectedWorkspace) {
  const calls = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    calls.push({ message, authorization: request.headers.authorization })
    let result = { protocolVersion: '2025-11-25' }
    if (message.method === 'tools/list') {
      const schema = { type: 'object', properties: {}, required: [] }
      if (audience === 'operator') {
        schema.properties.workspaceId = { type: 'string' }
        schema.required.push('workspaceId')
      }
      result = message.params.cursor === 'ci-page'
        ? { tools: [{ name: 'ci_run', inputSchema: schema }] }
        : { tools: [{ name: 'ci_get', inputSchema: schema }], nextCursor: 'ci-page' }
    }
    if (message.method === 'tools/call') {
      const { name, arguments: input } = message.params
      if (audience === 'operator' && name === 'workspace_list') {
        result = { content: [{ type: 'text', text: JSON.stringify({ items: [{ workspace: { id: expectedWorkspace } }] }) }] }
      } else if (audience === 'operator' && name === 'workspace_get') {
        result = { content: [{ type: 'text', text: JSON.stringify({ workspace: { repository: { owner: 'example', name: 'project' } } }) }] }
      } else {
        const permitted = ['ci_run', 'ci_get', 'ci_logs_read'].includes(name)
          && (audience === 'agent' ? !Object.hasOwn(input, 'workspaceId') : input.workspaceId === expectedWorkspace)
        if (!permitted) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_REQUEST' } }) }] }
        } else {
          let value = { ticketId: 'fixture-ticket' }
          if (name === 'ci_get') {
            value = { run: { id: 'fixture-ticket', suite: 'unit', state: 'failed' },
              wait: { status: 'settled' }, tests: { files: [] } }
          }
          if (name === 'ci_logs_read') value = { text: 'fixture failure' }
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
        }
      }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return { calls, url: `http://127.0.0.1:${server.address().port}` }
}

function installBridge(root, url, token) {
  const bridge = join(root, 'bridge')
  mkdirSync(join(bridge, 'routes'), { recursive: true })
  copyFileSync(new URL('./graphql-mcp.mjs', import.meta.url), join(bridge, 'launcher.mjs'))
  writeFileSync(join(bridge, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
    JSON.stringify({ endpoint: `${url}/mcp`, pid: process.pid,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), toolTimeoutMs: 300_000 }))
  return bridge
}

function runCli(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'unit', '--', 'node', '--test', 'sample.test.mjs'], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

for (const tokenName of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN']) {
  for (const workspaceId of [undefined, 'unrelated-workspace']) {
    test(`scoped CLI with ${tokenName} infers workspace for admission, waits and diagnostics (${workspaceId ?? 'no override'})`, async t => {
      const fixture = repository(t)
      const server = await endpoint(t, 'agent')
      const bridge = join(fixture.root, 'bridge')
      mkdirSync(join(bridge, 'routes'), { recursive: true })
      copyFileSync(new URL('./graphql-mcp.mjs', import.meta.url), join(bridge, 'launcher.mjs'))
      const token = 'scoped-cli-fixture'
      writeFileSync(join(bridge, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
        JSON.stringify({ endpoint: `${server.url}/mcp`, pid: process.pid,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), toolTimeoutMs: 300_000 }))
      const env = { ...fixture.env, CI: '', FOREMAN_CODE_CI_LOCAL: '',
        FOREMAN_CODE_APP_MCP_DIRECTORY: bridge, FOREMAN_CODE_CI_WAIT_MS: '10000',
        FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9', FOREMAN_CODE_OPERATOR_TOKEN: 'unrelated-operator' }
      delete env.FOREMAN_CODE_MCP_TOKEN
      delete env.GRAPHQL_MCP_TOKEN
      delete env.GRAPHQL_APP_MCP_DIRECTORY
      delete env.FOREMAN_CODE_WORKSPACE_ID
      if (workspaceId) env.FOREMAN_CODE_WORKSPACE_ID = workspaceId
      env[tokenName] = token
      const result = await runCli(fixture.cwd, env)
      assert.equal(result.code, 1, result.stderr)
      assert.match(result.stderr, /unit FAILED/, result.stderr)
      const tools = server.calls.filter(call => call.message.method === 'tools/call')
      assert.deepEqual(tools.map(call => call.message.params.name), ['ci_run', 'ci_get', 'ci_logs_read', 'ci_get'])
      assert.ok(tools.every(call => !Object.hasOwn(call.message.params.arguments, 'workspaceId')))
      assert.ok(server.calls.every(call => call.authorization === `Bearer ${token}`))
      const admission = tools[0].message.params.arguments
      assert.equal(admission.commit, fixture.commit)
      assert.equal(admission.scope, 'affected')
      assert.deepEqual(admission.files, ['sample.test.mjs'])
      assert.ok(admission.commandId)
      assert.equal(tools[1].message.params.arguments.waitUntil, 'group-terminal')
      assert.deepEqual(tools[3].message.params.arguments.testStatus, ['failed'])
      assert.match(result.stdout, /fixture failure/)
    })
  }
}

test('Operator CLI keeps its explicit workspace for admission, waits and diagnostics', async t => {
  const fixture = repository(t)
  const server = await endpoint(t, 'operator', 'chosen-workspace')
  const env = { ...fixture.env, CI: '', FOREMAN_CODE_CI_LOCAL: '', FOREMAN_CODE_MAIN_URL: server.url,
    FOREMAN_CODE_OPERATOR_TOKEN: 'operator-fixture', FOREMAN_CODE_WORKSPACE_ID: 'chosen-workspace' }
  delete env.FOREMAN_CODE_MCP_TOKEN
  delete env.GRAPHQL_MCP_TOKEN
  const result = await runCli(fixture.cwd, env)
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /unit FAILED/)
  const tools = server.calls.filter(call => call.message.method === 'tools/call')
  assert.deepEqual(tools.map(call => call.message.params.name), ['ci_run', 'ci_get', 'ci_logs_read', 'ci_get'])
  assert.ok(tools.every(call => call.message.params.arguments.workspaceId === 'chosen-workspace'))
  assert.ok(server.calls.every(call => call.authorization === 'Bearer operator-fixture'))
})

for (const tokenName of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN']) {
  for (const explicitWorkspace of [true, false]) {
    test(`Operator chat CLI with ${tokenName} uses its advertised workspace schema (${explicitWorkspace ? 'explicit' : 'discovered'})`, async t => {
      const fixture = repository(t)
      if (!explicitWorkspace) {
        execFileSync('git', ['-C', fixture.cwd, 'remote', 'set-url', '--push', 'origin', join(fixture.root, 'origin.git')])
        execFileSync('git', ['-C', fixture.cwd, 'remote', 'set-url', 'origin', 'https://github.com/example/project.git'])
      }
      const server = await endpoint(t, 'operator', 'chosen-workspace')
      const token = 'operator-chat-fixture'
      const bridge = installBridge(fixture.root, server.url, token)
      const env = { ...fixture.env, CI: '', FOREMAN_CODE_CI_LOCAL: '', FOREMAN_CODE_APP_MCP_DIRECTORY: bridge,
        FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9', FOREMAN_CODE_OPERATOR_TOKEN: 'unrelated-operator' }
      for (const key of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN', 'GRAPHQL_APP_MCP_DIRECTORY', 'FOREMAN_CODE_WORKSPACE_ID']) delete env[key]
      env[tokenName] = token
      if (explicitWorkspace) env.FOREMAN_CODE_WORKSPACE_ID = 'chosen-workspace'
      const result = await runCli(fixture.cwd, env)
      assert.equal(result.code, 1, result.stderr)
      assert.match(result.stderr, /unit FAILED/, result.stderr)
      const tools = server.calls.filter(call => call.message.method === 'tools/call')
      const ciCalls = tools.filter(call => call.message.params.name.startsWith('ci_'))
      assert.deepEqual(ciCalls.map(call => call.message.params.name), ['ci_run', 'ci_get', 'ci_logs_read', 'ci_get'])
      assert.ok(ciCalls.every(call => call.message.params.arguments.workspaceId === 'chosen-workspace'))
      assert.deepEqual(tools.filter(call => !call.message.params.name.startsWith('ci_')).map(call => call.message.params.name),
        explicitWorkspace ? [] : ['workspace_list', 'workspace_get'])
      assert.ok(server.calls.every(call => call.authorization === `Bearer ${token}`))
      assert.equal(server.calls.filter(call => call.message.method === 'tools/list').length, 2)
    })
  }
}

for (const directoryName of ['FOREMAN_CODE_APP_MCP_DIRECTORY', 'GRAPHQL_APP_MCP_DIRECTORY']) {
  test(`Agent CLI retains the configured bridge from ${directoryName} across environment stripping and account HOME changes`, async t => {
    const fixture = repository(t)
    const server = await endpoint(t, 'agent')
    const token = 'agent-runtime-fixture'
    const bridge = installBridge(fixture.root, server.url, token)
    const source = { ...fixture.env, CI: '', FOREMAN_CODE_CI_LOCAL: '',
      HOME: join(fixture.root, 'provider-account'), FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9',
      FOREMAN_CODE_OPERATOR_TOKEN: 'controller-secret', DATABASE_URL: 'controller-database',
      FOREMAN_CODE_APP_PRIVATE_KEY: 'controller-private-key' }
    for (const key of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_APP_MCP_DIRECTORY', 'GRAPHQL_APP_MCP_DIRECTORY']) delete source[key]
    source[directoryName] = bridge
    const stripped = inheritedAgentEnvironment(source)
    assert.equal(stripped.FOREMAN_CODE_APP_MCP_DIRECTORY, undefined)
    assert.equal(stripped.GRAPHQL_APP_MCP_DIRECTORY, undefined)
    const env = appMcpTokenEnvironment({ ...stripped, FOREMAN_CODE_MCP_TOKEN: token }, source)
    assert.equal(env.FOREMAN_CODE_APP_MCP_DIRECTORY, bridge)
    assert.equal(env.GRAPHQL_APP_MCP_DIRECTORY, undefined)
    for (const key of ['FOREMAN_CODE_OPERATOR_TOKEN', 'DATABASE_URL', 'FOREMAN_CODE_APP_PRIVATE_KEY']) assert.equal(env[key], undefined)
    const result = await runCli(fixture.cwd, env)
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /unit FAILED/, result.stderr)
    const tools = server.calls.filter(call => call.message.method === 'tools/call')
    assert.deepEqual(tools.map(call => call.message.params.name), ['ci_run', 'ci_get', 'ci_logs_read', 'ci_get'])
    assert.ok(tools.every(call => !Object.hasOwn(call.message.params.arguments, 'workspaceId')))
    assert.ok(server.calls.every(call => call.authorization === `Bearer ${token}`))
  })
}
