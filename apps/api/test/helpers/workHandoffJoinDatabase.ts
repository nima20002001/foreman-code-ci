import { afterAll, beforeAll } from 'vitest'
import { migratedDatabase } from './migratedDatabase.js'

/** Cases use distinct fixture IDs; migration setup is shared within each suite. */
export function workHandoffJoinDatabase() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  beforeAll(async () => {
    database = await migratedDatabase()
  }, 120000)
  afterAll(async () => {
    await database?.close()
  }, 120000)
  return () => {
    if (!database) throw new Error('Join test database is not initialized')
    return database
  }
}
