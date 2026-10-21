import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from 'vitest'
import pg from 'pg'
import { createTestRoot, provisionTestResources, removeTestRoot } from '../../../../scripts/test-resources.mjs'
import { stopGroup } from '../../../../scripts/integration-process.mjs'
import { assertOwnedTestApi } from './testResources.js'

export const root = fileURLToPath(new URL('../../../../', import.meta.url))
export const require = createRequire(import.meta.url)

export async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

export async function ready(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test API exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* ignore: startup may not have opened the listener yet. */ }
    await delay(25)
  }
  throw new Error('Test API did not become ready')
}

// Each rejected startup must leave its own database empty before a valid restart.
export async function rejectsUnownedStartup(variable: string): Promise<void> {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const outside = createTestRoot()
  const sentinel = join(outside.directory, 'retained.txt')
  await writeFile(sentinel, 'outside application state')
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), join(root, 'apps/api/src/server.ts')], {
    cwd: root, env: { ...resources.environment, [variable]: outside.directory,
      HOST: '127.0.0.1', PORT: String(port) },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const pool = new pg.Pool({ connectionString: resources.environment.TEST_DATABASE_URL, max: 1 })
  let restarted: ChildProcess | undefined
  try {
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(30_000) })
    expect(code).toBe(1)
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow()
    expect((await pool.query("select count(*)::int as count from pg_tables where schemaname not in ('pg_catalog','information_schema')"))
      .rows[0].count).toBe(0)
    expect(await readFile(sentinel, 'utf8')).toBe('outside application state')
    await stopGroup(child.pid, { signal: 'SIGTERM' })
    restarted = spawn(process.execPath, ['--import', require.resolve('tsx'), join(root, 'apps/api/src/server.ts')], {
      cwd: root, env: { ...resources.environment, HOST: '127.0.0.1', PORT: String(port) },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    restarted.stdout?.on('data', chunk => { output += String(chunk) })
    restarted.stderr?.on('data', chunk => { output += String(chunk) })
    try {
      await ready(restarted, port)
    } catch (error) {
      throw new Error(`Valid API restart failed: ${output}`, { cause: error })
    }
    await assertOwnedTestApi(new URL(`http://127.0.0.1:${port}`), pool, resources.environment)
    expect((await pool.query('select count(*)::int as count from runs')).rows[0].count).toBe(0)
    expect(await readFile(sentinel, 'utf8')).toBe('outside application state')
  } finally {
    await stopGroup(restarted?.pid, { signal: 'SIGTERM' })
    await stopGroup(child.pid, { signal: 'SIGTERM' })
    await pool.end()
    await resources.close()
    removeTestRoot(outside)
  }
}
