import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import { buildProductionApp } from '../src/production.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

it.skipIf(!postgresEnabled)('serves local human HTTP while native catalogs are pending and joins them on shutdown', async () => {
  const fixture = await currentDatabase()
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${fixture.schema},public`)
  const runtime = join(fixture.directory, 'runtime')
  const workspaces = join(fixture.directory, 'workspaces')
  await Promise.all([runtime, workspaces].map(directory => mkdir(directory, { mode: 0o700 })))
  const config = loadConfig({ DATABASE_URL: url.toString(), HARNESS_WORKSPACE_ROOT: runtime,
    WORKSPACE_STORAGE_ROOT: workspaces, FILE_STORAGE_ROOT: join(fixture.directory, 'files'), PORT: '4100' })
  const database = createDatabase(config.database)
  const checkpointSchema = `${fixture.schema}_checkpoints`
  const checkpoints = createCheckpointStore(process.env.TEST_DATABASE_URL!, checkpointSchema, config.database)
  let finishCatalogs!: () => void
  let catalogsStarted!: () => void
  let stopping!: () => void
  const pending = new Promise<void>(resolve => { finishCatalogs = resolve })
  const started = new Promise<void>(resolve => { catalogsStarted = resolve })
  const stoppedAdmission = new Promise<void>(resolve => { stopping = resolve })
  vi.spyOn(NativeConfigurationService.prototype, 'options').mockImplementation(async () => {
    catalogsStarted()
    await pending
    throw new Error('Provider catalog unavailable')
  })
  const releaseOwner = vi.spyOn(OperatorRuntimeOwner.prototype, 'close')
  const production = buildProductionApp(config, database, checkpoints, false)
  production.app.addHook('preClose', async () => { stopping() })
  try {
    await checkpoints.setup()
    await production.initialize()
    const address = await production.app.listen({ host: '127.0.0.1', port: 0 })
    await started
    const ready = await fetch(`${address}/health/ready`)
    expect(ready.status).toBe(200)
    expect((await ready.json()).checks).toEqual({ database: 'ok', checkpoints: 'ok' })
    const human = await fetch(`${address}/api/local-human`, { credentials: 'omit' })
    expect(human.status).toBe(200)
    expect((await human.json()).principal.id).toBe('principal-local-human')
    const closing = production.shutdown()
    await stoppedAdmission
    expect(releaseOwner).not.toHaveBeenCalled()
    finishCatalogs()
    await closing
    expect(releaseOwner).toHaveBeenCalledOnce()
  } finally {
    finishCatalogs()
    try {
      await production.shutdown()
    } finally {
      await checkpoints.close()
      await database.close()
      await fixture.pool.query(`drop schema if exists ${checkpointSchema} cascade`)
      await fixture.close()
      vi.restoreAllMocks()
    }
  }
}, 30_000)
