import { get, createServer, Agent } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localHumanClient, localHumanProxyRequest } from './localClientNode.js'

const lookup = vi.hoisted(() => ({ error: undefined as Error | undefined, output: '', calls: 0 }))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const execFile = Object.assign(actual.execFile.bind(null), {
    [promisify.custom]: async (...args: Parameters<typeof execute>) => {
      if (args[0] !== '/usr/bin/ss') return execute(...args)
      lookup.calls++
      if (lookup.error) throw lookup.error
      return { stdout: lookup.output, stderr: '' }
    },
  })
  return { ...actual, execFile }
})

beforeEach(() => {
  lookup.error = undefined
  lookup.output = `ESTAB 0 0 127.0.0.1:1234 127.0.0.1:5678 cgroup:/browser users:(("chrome",pid=${process.pid},fd=1))`
  lookup.calls = 0
})

async function fixture() {
  let forwarded = 0
  const server = createServer((request, response) => {
    void localHumanProxyRequest(request, response, error => {
      forwarded++
      response.writeHead(error ? 500 : 200)
      response.end(JSON.stringify({ forwarded: !error }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const request = (authorization?: string) => new Promise<{
    status: number | undefined; headers: import('node:http').IncomingHttpHeaders; body: unknown
  }>((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}/api/local-human`, {
      agent, headers: authorization ? { authorization } : {},
    }, response => {
      let body = ''
      response.on('data', chunk => { body += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }))
      response.on('error', reject)
    }).on('error', reject)
  })
  return { request, forwarded: () => forwarded, close: async () => {
    agent.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

describe.skipIf(process.platform !== 'linux')('local peer lookup failures', () => {
  it.each([
    ['timeout', { killed: true, signal: 'SIGTERM' }],
    ['exit status', { code: 1 }],
    ['output limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
    ['permission failure', { code: 'EACCES' }],
  ])('returns a retryable response for %s and retries the same socket', async (_name, properties) => {
    const app = await fixture()
    try {
      lookup.error = Object.assign(new Error('Command failed: private OS diagnostic'), properties)
      const response = await app.request()
      expect(response.status).toBe(503)
      expect(response.headers).toMatchObject({ 'retry-after': '1', 'cache-control': 'no-store' })
      expect(response.body).toEqual({ error: { code: 'LOCAL_CLIENT_UNAVAILABLE',
        message: 'Could not verify the local browser connection. Try again in a moment.', details: { retryable: true } } })
      expect(app.forwarded()).toBe(0)
      lookup.error = undefined
      expect((await app.request()).status).toBe(200)
      expect(lookup.calls).toBe(2)
      expect(app.forwarded()).toBe(1)
    } finally { await app.close() }
  })

  it.each(['', 'ESTAB 0 0 missing-process-boundary', 'cgroup:/browser\ncgroup:/other'])(
    'does not authenticate unknown socket output %j or cache it as a denial', async output => {
      const app = await fixture()
      const healthy = lookup.output
      try {
        lookup.output = output
        expect((await app.request()).status).toBe(503)
        expect(app.forwarded()).toBe(0)
        lookup.output = healthy
        expect((await app.request()).status).toBe(200)
      } finally { await app.close() }
    })

  it('shares concurrent attribution and lets all failed readers retry', async () => {
    const socket = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 5678 }
    lookup.error = Object.assign(new Error('Command timed out'), { killed: true })
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => localHumanClient(socket)))
    expect(attempts.every(result => result.status === 'rejected')).toBe(true)
    expect(lookup.calls).toBe(1)
    lookup.error = undefined
    await expect(localHumanClient(socket)).resolves.toBe(true)
    expect(lookup.calls).toBe(2)
  })

  it('keeps native agent denial and leaves bearer authentication to the API', async () => {
    const app = await fixture()
    try {
      lookup.output = 'ESTAB cgroup:/graphql-native-00000000-0000-4000-8000-000000000001'
      expect((await app.request()).status).toBe(403)
      lookup.error = Object.assign(new Error('Command failed'), { killed: true })
      expect((await app.request('Bearer restricted-credential')).status).toBe(200)
      expect(lookup.calls).toBe(1)
    } finally { await app.close() }
  })
})
