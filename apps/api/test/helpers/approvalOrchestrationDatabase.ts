import { afterAll, beforeAll } from 'vitest'
import { agent3Database } from './wave25Agent3.js'

/** Register a migrated database shared by cases with independent workflow identities. */
export function approvalOrchestrationDatabase() {
  let database: Awaited<ReturnType<typeof agent3Database>>

  beforeAll(async () => {
    database = await agent3Database()
  }, 60000)
  afterAll(async () => {
    await database?.close()
  }, 60000)

  return () => database
}
