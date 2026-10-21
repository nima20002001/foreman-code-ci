import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { integrationPhaseLine } from '../../../scripts/integration-phase.mjs'
import { createTestRoot, removeTestRoot } from '../../../scripts/test-resources.mjs'

const execute = promisify(execFile)
const databaseScript = new URL('../../../scripts/test-db.mjs', import.meta.url).pathname
const resourcesUrl = new URL('../../../scripts/test-resources.mjs', import.meta.url).href
const templateUrl = new URL('../../../scripts/test-database-template.mjs', import.meta.url).href
const cacheUrl = new URL('../../../scripts/ci-postgres-cache.mjs', import.meta.url).href

const cloneDatabase = `
  import { createTestRoot, createTestDatabase, dropTestDatabase, removeTestRoot, testAdminPool } from ${JSON.stringify(resourcesUrl)}
  import { createTestDatabaseTemplate, dropTestDatabaseTemplate } from ${JSON.stringify(templateUrl)}
  import { ciTemplateCacheDirectory } from ${JSON.stringify(cacheUrl)}
  const admin = await testAdminPool()
  const root = createTestRoot(process.env.FOREMAN_CODE_TEST_ROOT)
  let template
  let database
  try {
    template = await createTestDatabaseTemplate(admin, root, { cacheDirectory: ciTemplateCacheDirectory() })
    database = await createTestDatabase(admin, root, { template })
    console.log(JSON.stringify({ template, databaseName: database.name }))
  } finally {
    if (database) await dropTestDatabase(admin, database)
    if (template && !template.persistent) await dropTestDatabaseTemplate(admin, template)
    removeTestRoot(root)
    await admin.end()
  }
`

it('measures private setup and warm CI setup including PostgreSQL startup, migrations and a database clone', async () => {
  const root = createTestRoot(process.env.FOREMAN_CODE_TEST_ROOT)
  const cache = join(root.directory, 'postgres-cache')
  const project = `foreman-ci-pg-${createHash('sha256').update(cache).digest('hex').slice(0, 16)}`
  const jobs: NodeJS.ProcessEnv[] = []
  let retained: { directory: string; token: string } | undefined
  let persistentEnvironment: NodeJS.ProcessEnv | undefined
  const templates: string[] = []
  try {
    for (const mode of ['before', 'cold', 'after']) {
      const runId = randomUUID()
      const temporary = join(root.directory, runId)
      await mkdir(temporary, { mode: 0o700 })
      const env: NodeJS.ProcessEnv = { ...process.env, CI_HOST_RUNNER: mode === 'before' ? '0' : '1',
        FOREMAN_CODE_CI_HOST_RUN_ID: runId, FOREMAN_CODE_CI_POSTGRES_CACHE: cache,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '', TMPDIR: temporary }
      jobs.push(env)
      const started = performance.now()
      await execute(process.execPath, [databaseScript, 'up'], { env, timeout: 60_000 })
      const serverMs = performance.now() - started
      env.FOREMAN_CODE_CI_TEST_ADMIN_URL = await readFile(join(temporary, 'test-database-url'), 'utf8')
      const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', cloneDatabase], {
        env, timeout: 60_000,
      })
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
      templates.push(result.template.name)
      if (mode !== 'before') {
        expect(result.template.persistent).toBe(true)
        retained = result.template
        persistentEnvironment = env
      }
      const elapsedMs = performance.now() - started
      console.log(integrationPhaseLine('ci-postgres-setup.integration.test.ts', `${mode}-db-setup`, elapsedMs))
      console.log(integrationPhaseLine('ci-postgres-setup.integration.test.ts', `${mode}-server-startup`, serverMs))
      await execute(process.execPath, [databaseScript, 'down'], { env, timeout: 60_000 })
    }
    expect(templates[2]).toBe(templates[1])
  } finally {
    for (const env of jobs) await execute(process.execPath, [databaseScript, 'down'], { env, timeout: 60_000 })
    if (retained && persistentEnvironment) {
      await execute(process.execPath, ['--input-type=module', '--eval', `
        import { testAdminPool, removeTestRoot } from ${JSON.stringify(resourcesUrl)}
        import { dropTestDatabaseTemplate } from ${JSON.stringify(templateUrl)}
        const admin = await testAdminPool()
        try {
          const template = JSON.parse(process.env.CI_RETAINED_TEMPLATE)
          await dropTestDatabaseTemplate(admin, template)
          removeTestRoot(template)
        } finally { await admin.end() }
      `], { env: { ...persistentEnvironment, CI_RETAINED_TEMPLATE: JSON.stringify(retained) }, timeout: 60_000 })
    }
    // This test owns a separate cache and project, so its retained server can be removed after measurement.
    await execute('docker', ['compose', '--project-name', project, '--file',
      new URL('../../../compose.test.yaml', import.meta.url).pathname, 'down', '--volumes'], { timeout: 60_000 })
    removeTestRoot(root)
  }
}, 180_000)
