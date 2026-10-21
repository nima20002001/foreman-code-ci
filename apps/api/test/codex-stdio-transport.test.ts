import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'vitest'

import { CodexRpcError, CodexStdioTransport, isObject, type CodexProtocol } from '../src/modules/harnesses/codexStdioTransport.js'
import { calls, errorCode, fixture, fixtureProtocol, until, type Fixture } from './fixtures/codex-test-helpers.js'

// Transport fault tests intentionally isolate framing, IO and correlation from
// schema conversion. codex-protocol.test.ts exercises the qualified schema gate.
const protocol: CodexProtocol = { request() {}, serverRequest() {}, notification() {}, response() {}, serverResponse() {} }
let f: Fixture
const transports: CodexStdioTransport[] = []
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function transport(options: {
  requestHandler?: () => Promise<void>
  timeout?: number
  onDisconnect?: (error: Error) => void
} = {}): Promise<CodexStdioTransport> {
  const value = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, protocol,
    options.requestHandler ?? (async () => undefined), () => undefined,
    options.onDisconnect ?? (() => undefined), options.timeout ?? 5_000)
  transports.push(value)
  await value.start()
  return value
}
function observe<T>(value: Promise<T>): Promise<T> {
  void value.catch(() => {
    // ignore: the caller asserts the rejection; this only prevents an unhandled-rejection report meanwhile.
  })
  return value
}

describe.skipIf(process.platform === 'win32')('Codex owned stdio transport', () => {
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((value) => value.close()))
    await rm(f.directory, { recursive: true, force: true })
  })

  it('declares full-schema form support through the qualified native initialization request', async () => {
    const value = new CodexStdioTransport(f.binary, f.directory, {}, fixtureProtocol,
      async () => undefined, () => undefined, () => undefined)
    transports.push(value)
    await value.start()
    const initialize = (await calls(f.directory)).find((entry) =>
      isObject(entry.wire) && entry.wire.method === 'initialize')
    assert(isObject(initialize?.wire))
    assert(isObject(initialize.wire.params))
    assert.deepEqual(initialize.wire.params.capabilities,
      { experimentalApi: true, extensions: { 'openai/form': {} } })
    assert.equal(value.isConnected(), true)
  })

  it('drains large stderr output before initialization without forwarding diagnostics', async () => {
    await writeFile(f.binary, `#!${process.execPath}
const { createInterface } = require('node:readline')
void (async () => {
  await new Promise((resolve, reject) => {
    process.stderr.write((process.env.GRAPHQL_MCP_TOKEN + '\\n').repeat(65_536), (error) => error ? reject(error) : resolve())
  })
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const request = JSON.parse(line)
    if (request.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : request.params }) + '\\n')
    }
  }
})().catch(() => process.exit(1))
`)
    const observed: unknown[] = []
    const value = new CodexStdioTransport(
      f.binary, f.directory, { ...process.env, GRAPHQL_MCP_TOKEN: 'fixture-stderr-token' }, protocol,
      async () => undefined, (method, params) => { observed.push({ method, params }) }, (error) => { observed.push(error) }, 5_000,
    )
    transports.push(value)
    await value.start()
    assert.deepEqual(await value.request('test/echo', { alive: true }), { alive: true })
    assert.deepEqual(observed, [])
  }, 15_000)

  it('reports current callback-channel connectivity without submitting a native message', async () => {
    const value = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, protocol,
      async () => undefined, () => undefined, () => undefined)
    transports.push(value)
    assert.equal(value.isConnected(), false)
    await value.start()
    assert.equal(value.isConnected(), true)
    await value.close()
    assert.equal(value.isConnected(), false)
  })

  it('rejects oversized outbound requests and responses before native submission', async () => {
    const value = await transport()
    const controller = new AbortController()
    const oversized = { text: 'x'.repeat(4 * 1024 * 1024) }
    const cases = [
      { result: value.request('test/echo', oversized, controller.signal), code: 'CODEX_OUTBOUND_FRAME_LIMIT' },
      { result: value.respond(999, 'test/response', oversized), code: 'NATIVE_RESPONSE_INVALID' },
    ]
    for (const { result, code } of cases) {
      await assert.rejects(result, (error: unknown) => error instanceof Error
        && errorCode(error) === code && error.message.includes('nothing was submitted'))
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.deepEqual(await value.request('test/echo', { alive: true }), { alive: true })
  })

  it('F13: successful and failed RPCs remove every abort listener', async () => {
    // A short deadline would also bound initialization, which a loaded machine can exceed; cancel the failed RPC instead.
    const value = await transport({ timeout: 30_000 })
    const controller = new AbortController()
    for (let index = 0; index < 25; index += 1) {
      assert.deepEqual(await value.request('test/echo', { index }, controller.signal), { index })
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
    const failed = observe(value.request('test/noresponse', {}, controller.signal))
    await until(async () => (await calls(f.directory)).some(({ wire }) =>
      isObject(wire) && wire.method === 'test/noresponse') || undefined)
    controller.abort()
    await assert.rejects(failed)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

  it('F11: intentional close immediately settles outstanding submitted calls and clears listeners', async () => {
    const value = await transport({ timeout: 30_000 })
    const controller = new AbortController()
    const pending = observe(value.request('test/noresponse', {}, controller.signal))
    await pause(20)
    const started = Date.now()
    await value.close()
    await assert.rejects(pending, (error: unknown) => error instanceof CodexRpcError && error.uncertain)
    assert(Date.now() - started < 3_000)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

  it('F12/F13: timeout and post-submission abort retain uncertain operation identity without listeners', async () => {
    // The deadline also bounds provider startup, so it stays far above process scheduling delay on a loaded machine.
    const value = await transport({ timeout: 2_000 })
    const controller = new AbortController()
    const failures: CodexRpcError[] = []
    await assert.rejects(value.request('test/noresponse', {}, controller.signal), (error: unknown) => {
      assert(error instanceof CodexRpcError)
      assert.equal(error.uncertain, true)
      assert.equal(error.method, 'test/noresponse')
      assert.equal(errorCode(error), 'CODEX_APP_SERVER_TIMEOUT')
      failures.push(error)
      return true
    })
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    const aborted = observe(value.request('test/noresponse', {}, controller.signal))
    controller.abort()
    await assert.rejects(aborted, (error: unknown) => {
      assert(error instanceof CodexRpcError)
      assert.equal(error.uncertain, true)
      assert.equal(error.method, 'test/noresponse')
      assert.equal(errorCode(error), 'CODEX_APP_SERVER_REQUEST_CANCELED')
      failures.push(error)
      return true
    })
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    const submitted = await until(async () => {
      const requests = (await calls(f.directory)).flatMap(({ wire }) =>
        isObject(wire) && wire.method === 'test/noresponse' ? [wire] : [])
      return requests.length === 2 ? requests : undefined
    })
    assert.deepEqual(failures.map(error => error.operationId), submitted.map(request => request.id))
    assert.notEqual(failures[0]!.operationId, failures[1]!.operationId)
  })

  it('F10: an asynchronous native-request handler exception is caught at dispatch', async () => {
    let attempted = false
    const value = await transport({ requestHandler: async () => {
      attempted = true
      throw new Error('translation failed')
    } })
    await value.request('test/request')
    await until(async () => attempted)
    assert.deepEqual(await value.request('test/echo', { alive: true }), { alive: true })
  })

  it('F09: stdin EPIPE cannot become an unhandled stream error', async () => {
    // Provider startup shares the RPC deadline; process scheduling can exceed 200 ms in CI.
    const disconnected: Error[] = []
    const value = await transport({ timeout: 5_000, onDisconnect: error => { disconnected.push(error) } })
    assert.deepEqual(await value.request('test/epipe'), { stdinClosed: true })
    await assert.rejects(value.respond(998, 'test/response', {}), (error: unknown) =>
      errorCode(error) === 'NATIVE_RESPONSE_DELIVERY_UNCERTAIN')
    const failure = await until(async () => disconnected[0])
    assert.equal((failure as NodeJS.ErrnoException).code, 'EPIPE')
    assert.equal(value.isConnected(), false)
    // Running under --unhandled-rejections=strict makes boundary regressions fatal.
    await value.close()
  })

  it('an oversized unterminated stdout frame disconnects after delayed initialization', async () => {
    await writeFile(f.binary, `#!${process.execPath}
const { createInterface } = require('node:readline')
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n')
    }, 300)
  } else if (request.method === 'test/frame') {
    process.stdout.write('x'.repeat(5 * 1024 * 1024))
  }
})
`)
    const disconnected: Error[] = []
    const value = await transport({ timeout: 5_000, onDisconnect: error => { disconnected.push(error) } })
    const controller = new AbortController()
    await assert.rejects(value.request('test/frame', {}, controller.signal), (error: unknown) => {
      assert(error instanceof CodexRpcError)
      assert.equal(error.method, 'test/frame')
      assert.equal(error.uncertain, true)
      assert.equal(errorCode(error), 'CODEX_APP_SERVER_DISCONNECTED')
      return true
    })
    assert.equal(disconnected.length, 1)
    assert.equal(value.isConnected(), false)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    await assert.rejects(value.request('test/echo', {}), (error: unknown) =>
      error instanceof CodexRpcError && !error.uncertain && errorCode(error) === 'CODEX_APP_SERVER_DISCONNECTED')
    await value.close()
  })

  it('F08: a SIGTERM-ignoring provider is force-killed within the shutdown bound', async () => {
    await writeFile(join(f.directory, 'ignore-term'), '')
    const value = await transport()
    const started = Date.now()
    await value.close()
    assert(Date.now() - started < 4_000)
  })

  it('F08: descendants inheriting stdout are supervised, not left alive after parent shutdown', async () => {
    const value = await transport()
    const result = await value.request('test/descendant') as { pid: number }
    assert.equal(typeof result.pid, 'number')
    await pause(50)
    await value.close()
    await until(async () => {
      try { process.kill(result.pid, 0) } catch { return true }
      // Linux may retain a killed orphan as a zombie until PID 1 reaps it.
      if (process.platform === 'linux') {
        try { return /\) Z /.test(await readFile(`/proc/${result.pid}/stat`, 'utf8')) } catch { return true }
      }
      return false
    })
  })
})
