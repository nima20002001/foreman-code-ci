import { afterAll, beforeAll } from 'vitest'
import { migratedDatabase } from './migratedDatabase.js'

export function sharedWorkHandoffExhaustionDatabase() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  beforeAll(async () => {
    database = await migratedDatabase()
  }, 120000)
  afterAll(async () => {
    await database?.close()
  }, 120000)
  return () => {
    if (!database) throw new Error('Work handoff exhaustion database has not been initialized')
    return database
  }
}
