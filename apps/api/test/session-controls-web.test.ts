import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { sessionControlsWeb } from './helpers/sessionControlsWeb.js'

async function availablePort() {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The browser port was not allocated.')
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  return address.port
}

it('serves this checkout, proxies its selected API and closes its owned listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-controls-web-'))
  const api = Fastify()
  api.get('/api/browser-fixture', async () => ({ selectedApi: true }))
  let web: Awaited<ReturnType<typeof sessionControlsWeb>> | undefined
  let closed = false
  try {
    const baseUrl = await api.listen({ host: '127.0.0.1', port: 0 })
    const browserOrigin = `http://127.0.0.1:${await availablePort()}`
    web = await sessionControlsWeb({ root, baseUrl, browserOrigin })
    const page = await fetch(browserOrigin)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    await page.text()
    const identity = await fetch(`${browserOrigin}/__graphql_dev_identity`).then(response => response.json())
    expect(identity.apiUrl).toBe(baseUrl)
    expect(await fetch(`${browserOrigin}/api/browser-fixture`).then(response => response.json()))
      .toEqual({ selectedApi: true })
    await web.close()
    closed = true
    await expect(fetch(browserOrigin)).rejects.toThrow()
  } finally {
    try { if (!closed) await web?.close() }
    finally {
      await api.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}, 90000)
