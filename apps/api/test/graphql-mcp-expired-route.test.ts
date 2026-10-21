import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function callThroughLauncher(renewalFailure?: string) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'graphql-expired-route-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const launcher = join(directory, 'graphql-mcp.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const token = `expired-route-${Math.random().toString(36).slice(2)}`
  await registerAppRoute(token, 'http://127.0.0.1:9/mcp', new Date(Date.now() - 1_000).toISOString(), launcher,
    renewalFailure ? { renewalFailure } : {})
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'FOREMAN_CODE_MCP_TOKEN'))
  const child = spawn(process.execPath, [launcher], { env: { ...environment, GRAPHQL_MCP_TOKEN: token }, stdio: 'pipe' })
  cleanup.push(() => { child.kill() })
  const reply = new Promise<{ error: { message: string; data: { kind: string } } }>(resolve => {
    createInterface({ input: child.stdout }).on('line', line => resolve(JSON.parse(line)))
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} } })}\n`)
  return reply
}

it('reports why an expired route stopped renewing', async () => {
  const reply = await callThroughLauncher('AUTH_REVOKED: Main ended this attempt and revoked its credential')
  expect(reply.error.data.kind).toBe('renewal_failed')
  expect(reply.error.message).toContain('renewal failed: AUTH_REVOKED: Main ended this attempt and revoked its credential')
})

it('keeps the plain expiry message for a route that expired without a recorded failure', async () => {
  const reply = await callThroughLauncher()
  expect(reply.error.data.kind).toBe('route_unavailable')
  expect(reply.error.message).toContain('invalid or expired')
})
