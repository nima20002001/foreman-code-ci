import type pg from 'pg'
import type { z } from 'zod'
import type { CiGetOutputSchema } from '@foreman-code/contracts'
import { CiTicketChanges } from '../../src/modules/ci-host/ticketChanges.js'

type CiGetOutput = z.infer<typeof CiGetOutputSchema>

/** Wait for persisted background work through ticket notifications; executor operations are not repeated. */
export async function ciReadWhen(pool: pg.Pool, read: () => Promise<CiGetOutput>,
  matches: (output: CiGetOutput) => boolean): Promise<CiGetOutput> {
  const changes = new CiTicketChanges(pool)
  const watch = changes.subscribe(() => true)
  const deadline = performance.now() + 5000
  try {
    await watch.ready
    for (;;) {
      const version = watch.version()
      const output = await read()
      if (matches(output)) return output
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error(`CI state did not settle: ${JSON.stringify(output)}`)
      await watch.changedSince(version, remaining)
    }
  } finally {
    watch.close()
    changes.close()
  }
}
