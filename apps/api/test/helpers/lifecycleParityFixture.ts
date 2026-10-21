import { afterAll, afterEach, beforeAll } from 'vitest'
import { migratedDatabase } from './migratedDatabase.js'

export function lifecycleParityFixture() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  const closes: Array<() => Promise<void>> = []

  // Each case seeds distinct workflow/run IDs; only migrations and the pool are shared.
  beforeAll(async () => {
    database = await migratedDatabase()
  }, 60000)

  afterEach(async () => {
    while (closes.length) await closes.pop()!()
  })

  afterAll(async () => {
    if (database) await database.close()
  })

  return {
    database() {
      if (!database) throw new Error('Lifecycle parity database is not initialized')
      return database
    },
    closeAfterEach(close: () => Promise<void>) {
      closes.push(close)
    },
  }
}
