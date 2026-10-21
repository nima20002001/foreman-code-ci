import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { stopGroup } from '../../../scripts/integration-process.mjs'
import { createTestRoot, provisionTestResources, removeTestRoot } from '../../../scripts/test-resources.mjs'
import { freePort, rejectsUnownedStartup, require, root } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned CODEX_HOME',
  () => rejectsUnownedStartup('CODEX_HOME'),
  120_000,
)

it('rejects unowned storage before loading an unavailable database client', async () => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const outside = createTestRoot()
  const sentinel = join(outside.directory, 'retained.txt')
  const state = resources.environment.FOREMAN_CODE_TEST_ROOT!
  const preload = join(state, 'unavailable-database-preload.mjs')
  const loader = join(state, 'unavailable-database-loader.mjs')
  const pool = new pg.Pool({ connectionString: resources.environment.TEST_DATABASE_URL, max: 1 })
  const children: ReturnType<typeof spawn>[] = []
  const port = await freePort()
  try {
    await writeFile(sentinel, 'outside application state')
    await writeFile(preload, `import { register } from 'node:module';
      register(new URL('./unavailable-database-loader.mjs', import.meta.url));`)
    await writeFile(loader, `export function resolve(specifier, context, nextResolve) {
      if (specifier === 'pg') throw new Error('Database client dependency is unavailable');
      return nextResolve(specifier, context);
    }`)
    const start = async (environment: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, ['--import', require.resolve('tsx'), '--import', preload,
        join(root, 'apps/api/src/server.ts')], {
        cwd: root,
        env: { ...environment, HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'info' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      const [code] = await once(child, 'close', { signal: AbortSignal.timeout(30_000) })
      return { code, output }
    }
    const rejected = await start({ ...resources.environment, CODEX_HOME: outside.directory })
    expect(rejected.code, rejected.output).toBe(1)
    expect(rejected.output).toContain('Test path must remain inside its owned root')
    expect(rejected.output).not.toContain('Database client dependency is unavailable')
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`, {
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow()
    expect(await readFile(sentinel, 'utf8')).toBe('outside application state')
    expect((await pool.query("select count(*)::int as count from pg_tables where schemaname not in ('pg_catalog','information_schema')"))
      .rows[0].count).toBe(0)

    const valid = await start(resources.environment)
    expect(valid.code, valid.output).toBe(1)
    expect(valid.output).toContain('Database client dependency is unavailable')
  } finally {
    for (const child of children) await stopGroup(child.pid, { signal: 'SIGTERM' })
    await pool.end()
    await resources.close()
    removeTestRoot(outside)
  }
}, 120_000)
