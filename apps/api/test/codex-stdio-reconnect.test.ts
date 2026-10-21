import { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexRpcError, CodexStdioTransport, type CodexProtocol } from '../src/modules/harnesses/codexStdioTransport.js'

const recovery = vi.hoisted(() => ({ attach: vi.fn() }))
vi.mock('../src/modules/harnesses/recovery/processRegistry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/recovery/processRegistry.js')>(),
  hasDetachedStdioProcess: () => true,
  attachDetachedStdio: recovery.attach,
}))

class ObserverSocket extends Duplex {
  readonly submitted: Array<Record<string, unknown>> = []
  writeFailure: Error | undefined
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.submitted.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>)
    callback(this.writeFailure)
  }
  receive(message: Record<string, unknown>): void {
    this.push(JSON.stringify(message) + '\n')
  }
}

function observer() {
  const socket = new ObserverSocket()
  return {
    socket: socket as unknown as Socket,
    submitted: socket.submitted,
    stream: socket,
    threadSettings: {},
    originalProcessClosed: vi.fn(() => false),
    detach: vi.fn(async () => { socket.destroy() }),
    close: vi.fn(async () => { socket.destroy() }),
  }
}

const protocol: CodexProtocol = {
  request() {}, serverRequest() {}, notification() {}, response() {}, serverResponse() {},
}
const transports: CodexStdioTransport[] = []
async function connect(timeoutMs = 5_000) {
  const initial = observer()
  const replacement = observer()
  recovery.attach.mockResolvedValueOnce(initial).mockResolvedValueOnce(replacement)
  const notifications = vi.fn()
  const requests = vi.fn(async () => {})
  const disconnected = vi.fn()
  const transport = new CodexStdioTransport('fixture-codex', '/workspace', {}, protocol,
    requests, notifications, disconnected, timeoutMs, { root: '/private', owner: 'execution:fixture' },
    [], undefined, { reconnectableStdio: true })
  transports.push(transport)
  await transport.start()
  return { initial, replacement, notifications, requests, disconnected, transport }
}

describe('Codex retained observer recovery', () => {
  beforeEach(() => { recovery.attach.mockReset() })
  afterEach(async () => {
    await Promise.all(transports.splice(0).map(transport => transport.close()))
  })

  it.each(['thread/read', 'thread/turns/list', 'thread/items/list'])(
    'reconnects and retries %s while preserving turn notifications and native requests', async method => {
      const f = await connect()
      const read = f.transport.request(method, { threadId: 'saved-thread' })
      f.initial.stream.destroy()
      await vi.waitFor(() => expect(f.replacement.submitted).toHaveLength(1))
      expect(f.replacement.submitted[0]).toEqual(f.initial.submitted[0])
      const result = { thread: { id: 'saved-thread', turns: [{ id: 'saved-turn', status: 'completed' }] } }
      f.replacement.stream.receive({ id: f.replacement.submitted[0]!.id, result })
      await expect(read).resolves.toEqual(result)
      f.replacement.stream.receive({ method: 'turn/completed', params: { threadId: 'saved-thread', turnId: 'saved-turn' } })
      f.replacement.stream.receive({ id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'saved-thread' } })
      await vi.waitFor(() => expect(f.requests).toHaveBeenCalledOnce())
      expect(f.notifications).toHaveBeenCalledWith('turn/completed', { threadId: 'saved-thread', turnId: 'saved-turn' })
      expect(f.transport.isConnected()).toBe(true)
      expect(f.initial.close).not.toHaveBeenCalled()
      expect(f.disconnected).not.toHaveBeenCalled()
    },
  )

  it('recovers a read whose submission fails before the socket close notification', async () => {
    const f = await connect()
    f.initial.stream.writeFailure = Object.assign(new Error('Observer pipe closed.'), { code: 'EPIPE' })
    const read = f.transport.request('thread/turns/list', { threadId: 'saved-thread' })
    await vi.waitFor(() => expect(f.replacement.submitted).toHaveLength(1))
    f.replacement.stream.receive({ id: f.replacement.submitted[0]!.id, result: { data: [] } })
    await expect(read).resolves.toEqual({ data: [] })
    expect(f.disconnected).not.toHaveBeenCalled()
  })

  it.each(['turn/start', 'turn/steer'])('never replays an uncertain %s after reconnecting', async method => {
    const f = await connect()
    const mutation = f.transport.request(method, { threadId: 'saved-thread' })
    const rejected = expect(mutation).rejects.toMatchObject({
      uncertain: true, method, result: { error: { code: 'CODEX_OBSERVER_UNAVAILABLE' } },
    })
    f.initial.stream.destroy()
    await rejected
    await vi.waitFor(() => expect(recovery.attach).toHaveBeenCalledTimes(2))
    expect(f.replacement.submitted).toEqual([])
    expect(f.initial.submitted.filter(message => message.method === method)).toHaveLength(1)
  })

  it('retains the original daemon after bounded reconnect failure and permits a later recovery', async () => {
    const f = await connect()
    recovery.attach.mockReset().mockRejectedValueOnce(new Error('Observer unavailable.')).mockResolvedValueOnce(f.replacement)
    const read = f.transport.request('thread/turns/list', { threadId: 'saved-thread' })
    const rejected = expect(read).rejects.toMatchObject({ result: { error: { code: 'CODEX_OBSERVER_UNAVAILABLE' } } })
    f.initial.stream.destroy()
    await rejected
    expect(f.initial.close).not.toHaveBeenCalled()
    expect(f.disconnected).not.toHaveBeenCalled()
    expect(f.transport.isConnected()).toBe(false)
    const recovered = f.transport.request('thread/turns/list', { threadId: 'saved-thread' })
    await vi.waitFor(() => expect(f.replacement.submitted).toHaveLength(1))
    f.replacement.stream.receive({ id: f.replacement.submitted[0]!.id, result: { data: [] } })
    await expect(recovered).resolves.toEqual({ data: [] })
    expect(f.transport.isConnected()).toBe(true)
  })

  it('notifies an acknowledged turn stream when observer recovery fails without any pending RPC', async () => {
    const f = await connect()
    recovery.attach.mockReset().mockRejectedValueOnce(new Error('Observer unavailable.'))
    f.initial.stream.destroy()
    await vi.waitFor(() => expect(f.notifications).toHaveBeenCalledWith('transport/observerUnavailable', {}))
    expect(f.initial.close).not.toHaveBeenCalled()
    expect(f.disconnected).not.toHaveBeenCalled()
    expect(f.replacement.submitted).toEqual([])
  })

  it('reports a disconnected daemon only after its original process boundary is confirmed closed', async () => {
    const f = await connect()
    f.initial.originalProcessClosed.mockReturnValue(true)
    recovery.attach.mockReset().mockRejectedValueOnce(new Error('Original daemon exited.'))
    const read = f.transport.request('thread/turns/list', { threadId: 'saved-thread' })
    const rejected = expect(read).rejects.toBeInstanceOf(CodexRpcError)
    f.initial.stream.destroy()
    await rejected
    await vi.waitFor(() => expect(f.disconnected).toHaveBeenCalledOnce())
    expect(f.transport.originalProcessClosed()).toBe(true)
    expect(f.disconnected.mock.calls[0]![0]).toMatchObject({ result: { error: { code: 'CODEX_APP_SERVER_DISCONNECTED' } } })
  })

  it('honors request cancellation while authenticated reconnect is in progress', async () => {
    const f = await connect()
    let release!: () => void
    recovery.attach.mockReset().mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return f.replacement
    })
    f.initial.stream.destroy()
    await vi.waitFor(() => expect(recovery.attach).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const pending = f.transport.request('thread/read', { threadId: 'saved-thread' }, controller.signal)
    const canceled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await canceled
    release()
    await vi.waitFor(() => expect(f.transport.isConnected()).toBe(true))
    expect(f.replacement.submitted).toEqual([])
  })

  it('retains the daemon when a read deadline expires during authenticated reconnect', async () => {
    const f = await connect(100)
    let release!: () => void
    recovery.attach.mockReset().mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return f.replacement
    })
    const read = f.transport.request('thread/turns/list', { threadId: 'saved-thread' })
    const rejected = expect(read).rejects.toMatchObject({ result: { error: { code: 'CODEX_OBSERVER_UNAVAILABLE' } } })
    f.initial.stream.destroy()
    await rejected
    expect(f.initial.close).not.toHaveBeenCalled()
    expect(f.disconnected).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(f.transport.isConnected()).toBe(true))
    expect(f.replacement.submitted).toEqual([])
  })
})
