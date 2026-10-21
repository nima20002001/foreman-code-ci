import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { expect, it } from 'vitest'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { createFixtureDatabase, dropFixtureDatabase } from './helpers/testResources.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

async function runCli(file: string, connectionString: string, args: string[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(`../src/cli/${file}`, import.meta.url)), ...args], {
    env: { ...process.env, DATABASE_URL: connectionString, FOREMAN_CODE_DATABASE_URL: connectionString },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve({ code, output }))
  })
}

for (const file of ['migrate.ts', 'operatorCredentials.ts'] as const) {
  it.skipIf(!postgresEnabled)(`excludes ${file} schema changes while another runtime owns the database`, async () => {
    const databaseName = `maintenance_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.pathname = `/${databaseName}`
    await admin.connect()
    await createFixtureDatabase(admin, databaseName, 'template template0')
    const probe = new pg.Client({ connectionString: url.toString() })
    const first = new OperatorRuntimeOwner(url.toString(), error => { throw error })
    const args = file === 'operatorCredentials.ts' ? ['revoke', 'missing-principal'] : []
    try {
      await probe.connect()
      await first.acquire()
      const denied = await runCli(file, url.toString(), args)
      expect(denied.code).not.toBe(0)
      expect(denied.output).toContain('Another API process owns')
      expect((await probe.query("select to_regclass('workspaces') as table_name")).rows[0].table_name).toBeNull()
      await first.close()
      const admitted = await runCli(file, url.toString(), args)
      if (file === 'migrate.ts') expect(admitted.code, admitted.output).toBe(0)
      else expect(admitted.output).toContain('was not found')
      expect((await probe.query("select to_regclass('workspaces') as table_name")).rows[0].table_name).toBe('workspaces')
      const successor = new OperatorRuntimeOwner(url.toString(), error => { throw error })
      try { await successor.acquire(); expect(successor.active).toBe(true) } finally { await successor.close() }
    } finally {
      await first.close()
      await probe.end()
      await dropFixtureDatabase(admin, databaseName)
      await admin.end()
    }
  }, 30_000)
}

it.skipIf(!postgresEnabled)('releases migration ownership after a failed DDL batch', async () => {
  const databaseName = `maintenance_failure_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.pathname = `/${databaseName}`
  await admin.connect()
  await createFixtureDatabase(admin, databaseName, 'template template0')
  const probe = new pg.Client({ connectionString: url.toString() })
  try {
    await probe.connect()
    await probe.query('create table application_migrations (wrong_column text)')
    const result = await runCli('migrate.ts', url.toString())
    expect(result.code).not.toBe(0)
    expect((await probe.query("select to_regclass('workspaces') as table_name")).rows[0].table_name).toBeNull()
    const next = new OperatorRuntimeOwner(url.toString(), error => { throw error })
    try { await next.acquire(); expect(next.active).toBe(true) } finally { await next.close() }
  } finally {
    await probe.end()
    await dropFixtureDatabase(admin, databaseName)
    await admin.end()
  }
}, 30_000)
