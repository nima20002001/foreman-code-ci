import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { registerBuiltWeb } from '../src/builtWeb.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graphql-built-web-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Foreman Code</title><div id="root"></div>')
  await writeFile(join(root, 'assets/app-123.js'), 'console.log("compiled")')
  await writeFile(join(root, 'graphql.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const app = buildApp({ readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  } })
  cleanup.push(() => app.close())
  await registerBuiltWeb(app, root)
  return app
}

describe('built web hosting', () => {
  it('serves the dashboard and deep links without caching HTML', async () => {
    const app = await fixture()
    for (const url of [
      '/', '/workspaces', '/workspaces/workspace-1/workflows', '/workspaces/workspace-1/jobs',
      '/settings/harnesses',
      '/account', '/terminal', '/approvals',
    ]) {
      const response = await app.inject({ url })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.headers['cache-control']).toBe('no-cache')
      expect(response.body).toContain('<div id="root">')
    }
  })

  it('serves compiled assets and icons with their MIME types', async () => {
    const app = await fixture()
    const asset = await app.inject({ url: '/assets/app-123.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('javascript')
    expect(asset.headers['cache-control']).toContain('immutable')
    const icon = await app.inject({ url: '/graphql.svg' })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['content-type']).toContain('image/svg+xml')
    expect(icon.headers['cache-control']).toBe('no-cache')
  })

  it('preserves API, MCP and missing asset errors and rejects traversal', async () => {
    const app = await fixture()
    expect((await app.inject({ url: '/health/ready' })).json()).toMatchObject({ status: 'ok' })
    for (const url of ['/api/missing', '/mcp', '/health/missing', '/sign-in', '/setup',
      '/assets/missing.js', '/assets/%2e%2e/%2e%2e/package.json']) {
      const response = await app.inject({ url, headers: { accept: 'text/html' } })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    }
    expect((await app.inject({ method: 'POST', url: '/workspaces' })).statusCode).toBe(404)
  })

  it('fails startup if the build is absent or the directory is relative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graphql-missing-web-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const app = buildApp({ readiness: {
      database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
    } })
    cleanup.push(() => app.close())
    await expect(registerBuiltWeb(app, 'dist')).rejects.toThrow('absolute directory')
    await expect(registerBuiltWeb(app, root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
