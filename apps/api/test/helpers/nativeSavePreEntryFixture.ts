import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { agent3Database } from './wave25Agent3.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'

export function nativeSavePreEntryFixtures() {
  let database: Awaited<ReturnType<typeof agent3Database>> | undefined

  beforeAll(async () => {
    database = await agent3Database()
  }, 60000)

  afterAll(async () => {
    await database?.close()
  }, 60000)

  return async (form: 'single' | 'repeat') => {
    if (!database) throw new Error('Pre-entry fixture database is not initialized')
    return currentOperatorIntegration({
      database,
      fixture: makeCurrentWorkflowFixture(randomUUID(), form),
      approvalNodeIds: [],
    })
  }
}
