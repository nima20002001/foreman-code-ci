import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it, vi } from 'vitest'
import { APP_MCP_TIMEOUTS } from '../src/modules/harnesses/appMcpLauncher.js'
import { deviceRequestTimeoutMs } from '../src/modules/devices/deviceRequestRetry.js'
import { deviceForegroundWaitMs } from '../src/modules/devices/deviceRequestQueue.js'
import { withWorkerMcpDeadline } from '../src/modules/devices/workerMcpDeadline.js'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanup.length) await cleanup.pop()!()
})

interface Reply {
  result?: { structuredContent: { stored: boolean } }
  error?: { data: { code: string } }
}

async function uploadBridge(format: 'json' | 'sse' = 'json') {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'mcp-http-upload-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  let begin!: () => void
  let progress!: (bytes: number) => void
  let uploaded!: () => void
  let complete!: () => void
  let active!: AbortSignal
  let accepted!: () => void
  const started = new Promise<void>(resolve => { accepted = resolve })
  let calls = 0
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      calls++
      const controller = new AbortController()
      response.once('close', () => controller.abort())
      const pending = withWorkerMcpDeadline(async (signal, onUploaded, onProgress, onStarted) => {
        active = signal
        begin = onStarted
        progress = onProgress
        uploaded = onUploaded
        accepted()
        await new Promise<void>(resolve => { complete = resolve })
        signal.throwIfAborted()
      }, controller.signal, { uploading: true })
      void pending.then(() => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1,
          result: { content: [], structuredContent: { stored: true } } })
        response.writeHead(200, { 'content-type': format === 'json' ? 'application/json' : 'text/event-stream' })
        response.end(format === 'json' ? body : `data: ${body}\n\n`)
      }, (error: { code: string }) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, data: { code: error.code } } }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => {
    complete?.()
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP test listener')
  const token = 'upload-fixture-token'
  await mkdir(join(directory, 'routes'))
  await writeFile(join(directory, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`), JSON.stringify({
    endpoint: `http://127.0.0.1:${address.port}/mcp`, pid: process.pid,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), toolTimeoutMs: APP_MCP_TIMEOUTS.tool_timeout_sec * 1000,
  }))
  const clock = join(directory, 'clock.mjs')
  await writeFile(clock, `
    import { mock } from 'node:test'
    import { setImmediate } from 'node:timers'
    import { subscribe } from 'node:diagnostics_channel'
    subscribe('undici:request:error', ({ error }) => process.stderr.write(error.code + '\\n'))
    mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    // Node 22 mock timers implement refresh() as a no-op; restore its rescheduling semantics.
    const schedule = globalThis.setTimeout
    const cancel = globalThis.clearTimeout
    const refreshed = new WeakMap()
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      const handle = schedule(callback, milliseconds, ...args)
      refreshed.set(handle, handle)
      handle.refresh = () => {
        cancel(refreshed.get(handle))
        refreshed.set(handle, schedule(callback, milliseconds, ...args))
        return handle
      }
      return handle
    }
    globalThis.clearTimeout = handle => cancel(refreshed.get(handle) ?? handle)
    process.on('message', milliseconds => {
      // Undici refreshes its short clock timer after each tick; let it run every scheduled tick.
      for (let elapsed = 0; elapsed < milliseconds; elapsed++) mock.timers.tick(1)
      setImmediate(() => process.send('advanced'))
    })
    process.send('ready')
  `)
  const child = spawn(process.execPath, ['--import', clock, launcher], {
    env: { ...process.env, FOREMAN_CODE_MCP_TOKEN: token, GRAPHQL_MCP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  cleanup.push(async () => {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  })
  let diagnostics = ''
  child.stderr!.on('data', chunk => { diagnostics += String(chunk) })
  await once(child, 'message')
  const replies: Reply[] = []
  const lines = createInterface({ input: child.stdout! })
  cleanup.push(() => lines.close())
  let answer!: (reply: Reply) => void
  const reply = new Promise<Reply>(resolve => { answer = resolve })
  lines.on('line', line => {
    const value = JSON.parse(line) as Reply
    replies.push(value)
    answer(value)
  })
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'reference_file_add', arguments: {} } })}\n`)
  await started
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const advance = async (milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(milliseconds)
    const advanced = once(child, 'message')
    child.send(milliseconds)
    await advanced
  }
  return { advance, reply, replies, begin: () => begin(), progress: (bytes: number) => progress(bytes),
    uploaded: () => uploaded(), complete: () => complete(), active: () => active, calls: () => calls,
    diagnostics: () => diagnostics }
}

it.each(['json', 'sse'] as const)(
  'delivers a progressing 25 MiB upload after queueing, 400 seconds of upload and execution (%s)', async format => {
  const bridge = await uploadBridge(format)
  await bridge.advance(deviceRequestTimeoutMs + deviceForegroundWaitMs)
  bridge.begin()
  for (let seconds = 10; seconds <= 400; seconds += 10) {
    await bridge.advance(10_000)
    bridge.progress(seconds * 64 * 1024)
    expect(bridge.active().aborted, bridge.diagnostics()).toBe(false)
  }
  bridge.uploaded()
  await bridge.advance(90_000)
  bridge.complete()
  expect(await bridge.reply).toMatchObject({ result: { structuredContent: { stored: true } } })
  expect(bridge.calls()).toBe(1)
  expect(bridge.replies).toHaveLength(1)
})

it('returns the upload stall failure after fifteen seconds without retrying the call', async () => {
  const bridge = await uploadBridge()
  bridge.begin()
  for (let seconds = 10; seconds <= 310; seconds += 10) {
    await bridge.advance(10_000)
    bridge.progress(seconds * 64 * 1024)
  }
  await bridge.advance(14_999)
  expect(bridge.active().aborted, bridge.diagnostics()).toBe(false)
  await bridge.advance(1)
  expect(bridge.active().aborted).toBe(true)
  expect(await bridge.reply).toMatchObject({ error: { data: { code: 'timeout' } } })
  expect(bridge.calls()).toBe(1)
  expect(bridge.replies).toHaveLength(1)
})
