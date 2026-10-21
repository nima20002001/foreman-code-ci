import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { deferred } from './helpers/deferred.js'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'

it('refreshes same-token lease expiration and removes revoked routes and shutdown metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'app-routes-'))
  let rows = [{ token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const routes = new AppMcpRoutes(pool, 'http://127.0.0.1:3002/mcp', join(directory, 'launcher.mjs'))
  try {
    await routes.refresh()
    const file = join(directory, 'routes', `${'a'.repeat(64)}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ expiresAt: rows[0]!.expires_at.toISOString() })
    rows = [{ ...rows[0]!, expires_at: new Date(Date.now() + 120_000) }]
    await routes.refresh()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ expiresAt: rows[0]!.expires_at.toISOString() })
    rows = []
    await routes.refresh()
    expect(await readdir(join(directory, 'routes'))).toEqual([])
    rows = [{ token_hash: 'b'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
    await routes.refresh()
    await routes.close()
    expect(await readdir(join(directory, 'routes'))).toEqual([])
  } finally { await routes.close(); await rm(directory, { recursive: true, force: true }) }
})


it.each(['cleanup', 'renewal'] as const)('preserves a successor route during predecessor %s', async action => {
  const directory = await privateFixtureDirectory('route-handoff-')
  const rows = [{ token_hash: 'c'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const launcher = join(directory, 'launcher.mjs')
  const first = new AppMcpRoutes(pool, 'http://127.0.0.1:3101/mcp', launcher)
  const second = new AppMcpRoutes(pool, 'http://127.0.0.1:3102/mcp', launcher)
  try {
    await first.refresh()
    await second.refresh()
    if (action === 'cleanup') await first.close()
    else await first.refresh()
    const saved = JSON.parse(await readFile(join(directory, 'routes', `${rows[0]!.token_hash}.json`), 'utf8'))
    expect(saved).toMatchObject({ endpoint: 'http://127.0.0.1:3102/mcp' })
  } finally {
    await first.close()
    await second.close()
    await removeFixtureDirectory(directory)
  }
})

it('rejects refresh admission after close begins and never republishes a closed route', async () => {
  const directory = await privateFixtureDirectory('route-close-')
  const rows = [{ token_hash: 'd'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const entered = deferred()
  const release = deferred()
  let hold = false
  const pool = { query: async () => {
    if (hold) {
      entered.resolve()
      await release.promise
    }
    return { rows }
  } } as unknown as pg.Pool
  const routes = new AppMcpRoutes(pool, 'http://127.0.0.1:3101/mcp', join(directory, 'launcher.mjs'))
  try {
    await routes.refresh()
    hold = true
    const refreshing = routes.refresh().then(() => undefined, (error: unknown) => error)
    await entered.promise
    const closing = routes.close()
    const obsolete = routes.refresh().then(() => undefined, (error: unknown) => error)
    release.resolve()
    await refreshing
    await closing
    expect(await obsolete).toBeInstanceOf(Error)
    expect(await readdir(join(directory, 'routes'))).toEqual([])
  } finally {
    release.resolve()
    await routes.close()
    await removeFixtureDirectory(directory)
  }
})


it('cannot overwrite a successor after a predecessor lease query resumes', async () => {
  const directory = await privateFixtureDirectory('route-delayed-renewal-')
  const rows = [{ token_hash: 'f'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const entered = deferred()
  const release = deferred()
  let hold = false
  const firstPool = { query: async () => {
    if (hold) {
      entered.resolve()
      await release.promise
    }
    return { rows }
  } } as unknown as pg.Pool
  const secondPool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const launcher = join(directory, 'launcher.mjs')
  const first = new AppMcpRoutes(firstPool, 'http://127.0.0.1:3101/mcp', launcher)
  const second = new AppMcpRoutes(secondPool, 'http://127.0.0.1:3102/mcp', launcher)
  try {
    await first.refresh()
    hold = true
    const delayed = first.refresh()
    await entered.promise
    await second.refresh()
    release.resolve()
    await delayed
    const saved = JSON.parse(await readFile(join(directory, 'routes', `${rows[0]!.token_hash}.json`), 'utf8'))
    expect(saved).toMatchObject({ endpoint: 'http://127.0.0.1:3102/mcp' })
  } finally {
    release.resolve()
    await first.close()
    await second.close()
    await removeFixtureDirectory(directory)
  }
})
