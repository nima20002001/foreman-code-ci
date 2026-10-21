import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { migratedDatabase } from './migratedDatabase.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

export function cleanupDeliveryFixtures() {
  let db: Awaited<ReturnType<typeof migratedDatabase>>
  const closes: Array<() => Promise<void>> = []

  beforeAll(async () => {
    db = await migratedDatabase()
  }, 60000)

  afterEach(async () => {
    try {
      while (closes.length) await closes.pop()!()
    } finally {
      vi.restoreAllMocks()
    }
  })

  afterAll(async () => {
    await db?.close()
  })

  return {
    database: () => db,
    async fixture() {
      const f = await checkpointRuntimeFixture(1, 1, { database: db })
      closes.push(f.close)
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction) throw new Error('Expected captured native wait')
      return { ...f, interaction }
    },
  }
}

export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native I/O blocked the Run publication lock')), 5000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
