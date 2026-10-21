import { readUntil } from './helpers/observableCondition.js'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import pg from 'pg'
import { provisionTestResources } from '../../../scripts/test-resources.mjs'
import { stopGroup } from '../../../scripts/integration-process.mjs'
import { assertOwnedTestApi } from './helpers/testResources.js'
import { freePort, ready, require, root } from './helpers/testStartupIsolation.js'

it.each(['explicit env file', 'default .env'])('isolates real API startup from %s logs and authentication', async selector => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const state = resources.environment.FOREMAN_CODE_TEST_ROOT!
  const ambient = join(state, 'ambient-app')
  await mkdir(ambient, { mode: 0o700 })
  const log = join(ambient, 'api.log')
  const rotated = join(ambient, 'api.1.log')
  await writeFile(log, 'application log sentinel')
  await writeFile(rotated, 'application rotation sentinel')
  await utimes(rotated, new Date(0), new Date(0))
  const envFile = join(ambient, '.env')
  await writeFile(envFile, `LOG_FILE=${log}\nOPENAI_API_KEY=ambient-provider-sentinel\n`)
  const { testEnvironment } = await import('../../../scripts/test-resources.mjs')
  const environment = testEnvironment({ PATH: process.env.PATH,
    ...(selector === 'explicit env file' ? { FOREMAN_CODE_API_ENV_FILE: envFile } : {}) }, {
    directory: state, token: resources.environment.FOREMAN_CODE_TEST_OWNER!,
    name: new URL(resources.environment.TEST_DATABASE_URL!).pathname.slice(1),
    databaseUrl: resources.environment.TEST_DATABASE_URL!,
  })
  const observation = join(state, 'startup-environment.json')
  const observer = join(state, 'observe.mjs')
  await writeFile(observer, `import { renameSync, writeFileSync } from 'node:fs';
    setInterval(() => {
      writeFileSync(${JSON.stringify(observation + '.tmp')}, JSON.stringify({
        ambientKey: process.env.OPENAI_API_KEY === 'ambient-provider-sentinel',
        logFile: process.env.LOG_FILE ?? null
      }));
      renameSync(${JSON.stringify(observation + '.tmp')}, ${JSON.stringify(observation)});
    }, 20).unref();`)
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'),
    '--import', observer, join(root, 'apps/api/src/server.ts')], {
    cwd: ambient, env: { ...environment, HOST: '127.0.0.1', PORT: String(port) },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  try {
    await ready(child, port)
    const pool = new pg.Pool({ connectionString: environment.TEST_DATABASE_URL, max: 1 })
    try {
      const origin = new URL(`http://127.0.0.1:${port}`)
      await expect(assertOwnedTestApi(origin, pool)).rejects.toThrow('does not own the disposable test database')
      await assertOwnedTestApi(origin, pool, environment)
    }
    finally { await pool.end() }
    const observed = await readUntil(async () => {
      try {
        return JSON.parse(await readFile(observation, 'utf8')) as { ambientKey: boolean; logFile: string | null }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      }
    }, value => value?.ambientKey === false && value.logFile === null,
    { timeoutMs: 2000, description: 'the isolated startup environment observation' })
    expect(observed).toEqual({ ambientKey: false, logFile: null })
    expect(await readFile(log, 'utf8')).toBe('application log sentinel')
    expect(await readFile(rotated, 'utf8')).toBe('application rotation sentinel')
    expect((await readdir(environment.LOG_DIR!)).length).toBeGreaterThan(0)
  } finally {
    await stopGroup(child.pid, { signal: 'SIGTERM' })
    await resources.close()
  }
}, 120_000)

