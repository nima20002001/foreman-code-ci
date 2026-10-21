import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { removeFixtureDirectory } from '../helpers/testResources.js'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { APP_MCP_TIMEOUTS } from '../../src/modules/harnesses/appMcpLauncher.js'

export interface LauncherMessage {
  id?: string | number
  method: string
  params?: Record<string, unknown>
}
export interface LauncherOutput {
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export async function mcpLauncherFixture(
  handle: (message: LauncherMessage, response: ServerResponse) => void,
  options: { preload?: string; unavailableEndpoint?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-launcher-'))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    handle(JSON.parse(body), response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  const token = 'launcher-test-credential'
  await mkdir(join(directory, 'routes'))
  await writeFile(join(directory, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
    JSON.stringify({ endpoint, pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      toolTimeoutMs: APP_MCP_TIMEOUTS.tool_timeout_sec * 1000 }))
  if (options.unavailableEndpoint) await new Promise<void>((resolve) => server.close(() => resolve()))
  const args = [launcher]
  if (options.preload) {
    const preload = join(directory, 'preload.mjs')
    await writeFile(preload, options.preload)
    args.unshift('--import', preload)
  }
  const child = spawn(process.execPath, args, {
    env: { ...process.env, GRAPHQL_MCP_TOKEN: token }, stdio: 'pipe',
  })
  const messages: LauncherOutput[] = []
  const waiters = new Map<string | number, (value: LauncherOutput) => void>()
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line) as LauncherOutput
    messages.push(message)
    if (message.id !== null) {
      waiters.get(message.id)?.(message)
      waiters.delete(message.id)
    }
  })
  return {
    messages,
    send: (message: LauncherMessage) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    receive: (id: string | number) => {
      const existing = messages.find((message) => message.id === id)
      if (existing) return Promise.resolve(existing)
      return new Promise<LauncherOutput>((resolve) => waiters.set(id, resolve))
    },
    async close() {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await exited
      }
      lines.close()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      await removeFixtureDirectory(directory)
      if (stderr) throw new Error(stderr)
    },
  }
}
