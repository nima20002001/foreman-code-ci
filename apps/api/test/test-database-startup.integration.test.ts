import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

const execute = promisify(execFile)

async function hostDatabaseClient(env: NodeJS.ProcessEnv) {
  // Each job declares its own disposable server before the inherited connection guard loads.
  const resources = new URL('../../../scripts/test-resources.mjs', import.meta.url)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { testAdminPool } from ${JSON.stringify(resources.href)}
    const pool = await testAdminPool()
    process.on('message', async statement => {
      if (statement?.type === 'close') {
        await pool.end()
        process.disconnect()
        return
      }
      try {
        process.send({ rows: (await pool.query(statement)).rows })
      } catch (error) {
        process.send({ error: error.message })
      }
    })
    process.send({ rows: [] })
  `], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr += text })
  const closed = once(child, 'exit').then(([code]) => code as number | null)
  const read = async () => {
    const [message] = await Promise.race([
      once(child, 'message'),
      closed.then(code => { throw new Error(`Host database client exited (${code}): ${stderr}`) }),
    ])
    const reply = message as { rows: Record<string, unknown>[]; error?: string }
    if (reply.error) throw new Error(reply.error)
    return reply
  }
  try {
    await read()
  } catch (error) {
    child.kill()
    await closed
    throw error
  }
  return {
    async query(statement: string) {
      child.send(statement)
      return read()
    },
    async end() {
      child.send({ type: 'close' })
      const code = await closed
      if (code !== 0) throw new Error(`Host database client exited (${code}): ${stderr}`)
    },
  }
}

it('closes the database client process after returning query results', async () => {
  const client = await hostDatabaseClient(process.env)
  try {
    expect((await client.query('select 1 as alive')).rows).toEqual([{ alive: 1 }])
  } finally {
    await client.end()
  }
})

it('keeps an active database session and its rows when another checkout starts the shared test server', async () => {
  const fixture = await currentDatabase()
  const client = await fixture.pool.connect()
  try {
    await client.query('create table startup_survival (value text not null)')
    await client.query('insert into startup_survival values ($1)', ['retained test data'])
    const before = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const scripts = join(fixture.directory, 'scripts')
    await mkdir(scripts, { mode: 0o700 })
    // The copied checkout must reuse the same server through either database provider.
    await copyFile(new URL('../../../compose.test.yaml', import.meta.url), join(fixture.directory, 'compose.test.yaml'))
    for (const name of ['test-db.mjs', 'test-postgres-init.sql', 'ci-postgres-cache.mjs']) {
      await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(scripts, name))
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await execute(process.execPath, [join(scripts, 'test-db.mjs'), 'up'], {
        cwd: fixture.directory, timeout: 30_000,
      })
    }
    expect((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid).toBe(before)
    expect((await client.query('select value from startup_survival')).rows)
      .toEqual([{ value: 'retained test data' }])
  } finally {
    client.release()
    await fixture.close()
  }
}, 60_000)

for (const action of ['stop', 'down']) {
  it(`refuses ${action} for PostgreSQL owned by the verification runtime`, async () => {
    await expect(execute(process.execPath, [new URL('../../../scripts/test-db.mjs', import.meta.url).pathname, action], {
      env: { ...process.env, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
        FOREMAN_CODE_CI_TEST_DATABASE: 'running', PATH: '/no-docker' }, timeout: 10_000,
    })).rejects.toMatchObject({ stderr: expect.stringContaining('runtime owns private PostgreSQL shutdown') })
  })
}

it('refuses private database startup without the runtime-owned running server', async () => {
  await expect(execute(process.execPath, [new URL('../../../scripts/test-db.mjs', import.meta.url).pathname, 'up'], {
    env: { ...process.env, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
      FOREMAN_CODE_CI_TEST_DATABASE: '', PATH: '/no-docker' }, timeout: 10_000,
  })).rejects.toMatchObject({ stderr: expect.stringContaining('must start its private PostgreSQL') })
})

// The verification runtime has no Docker; it owns one private PostgreSQL per job instead.
it.skipIf(process.env.FOREMAN_CODE_VERIFICATION_ENVIRONMENT === 'isolated-job-v1').each([0, 1])(
  'starts separate initialized databases for concurrent host CI jobs from a private checkout, stopping job %i',
  async stoppedIndex => {
    const checkout = await mkdtemp(join(tmpdir(), 'private-checkout-'))
    await mkdir(join(checkout, 'scripts'), { mode: 0o700 })
    // Host CI checkouts are private: the container user cannot read these files.
    await copyFile(new URL('../../../compose.test.yaml', import.meta.url), join(checkout, 'compose.test.yaml'))
    for (const name of ['test-db.mjs', 'test-postgres-init.sql', 'ci-postgres-cache.mjs']) {
      await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(checkout, 'scripts', name))
      await chmod(join(checkout, 'scripts', name), 0o600)
    }
    const jobs = await Promise.all([0, 1].map(async index => {
      const runDirectory = join(checkout, `run-${index}`)
      await mkdir(runDirectory, { mode: 0o700 })
      return { runDirectory, env: { ...process.env, FOREMAN_CODE_CI_HOST_RUN_ID: randomUUID(),
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '', TMPDIR: runDirectory, CI_HOST_RUNNER: '0' } }
    }))
    const database = (action: string, env: NodeJS.ProcessEnv) =>
      execute(process.execPath, [join(checkout, 'scripts', 'test-db.mjs'), action], { env, timeout: 60_000 })
    const clients: Awaited<ReturnType<typeof hostDatabaseClient>>[] = []
    try {
      await Promise.all(jobs.map(job => database('up', job.env)))
      for (const job of jobs) {
        const client = await hostDatabaseClient({ ...job.env,
          FOREMAN_CODE_CI_TEST_ADMIN_URL: await readFile(join(job.runDirectory, 'test-database-url'), 'utf8') })
        clients.push(client)
        expect((await client.query(`select shobj_description(oid, 'pg_database') as owner from pg_database
          where datname in ('postgres', 'graphql_test_control')`)).rows)
          .toEqual([{ owner: 'graphql-disposable-test-server' }, { owner: 'graphql-disposable-test-server' }])
      }
      const first = clients[stoppedIndex]!
      const second = clients[1 - stoppedIndex]!
      const pid = (await second.query('select pg_backend_pid() as pid')).rows[0]!.pid
      await first.query('create table first_job_only (value text)')
      expect((await second.query(`select to_regclass('first_job_only') as relation`)).rows).toEqual([{ relation: null }])
      await first.end()
      clients.splice(stoppedIndex, 1)
      await database('down', jobs[stoppedIndex]!.env)
      expect((await second.query('select 1 as alive')).rows).toEqual([{ alive: 1 }])
      expect((await second.query('select pg_backend_pid() as pid')).rows).toEqual([{ pid }])
    } finally {
      for (const client of clients) await client.end()
      for (const job of jobs) await database('down', job.env)
      await rm(checkout, { recursive: true, force: true })
    }
  }, 180_000)
