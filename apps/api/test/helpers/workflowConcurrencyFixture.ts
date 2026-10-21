import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { migratedDatabase } from './migratedDatabase.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

export function workflowConcurrencyFixture() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined

  beforeAll(async () => {
    database = await migratedDatabase()
  }, 60_000)

  afterAll(async () => {
    await database?.close()
  }, 60_000)

  return (options: { workerParallelism?: number } = {}) => {
    if (!database) throw new Error('Workflow concurrency database is not initialized')
    return checkpointRuntimeFixture(1, 1, {
      ...options,
      database,
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [],
    })
  }
}
