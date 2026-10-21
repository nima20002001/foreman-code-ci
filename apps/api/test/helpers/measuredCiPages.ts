import type pg from 'pg'

/** Records CI heap page reads per checked-out connection, excluding its earlier fixture work. */
export function measuredCiPages(pool: pg.Pool) {
  const pages = { max: 0 }
  const measured = { connect: async () => {
    const client = await pool.connect()
    let fetched = 0
    const readPages = async () => (await client.query<{ pages: number }>(
      "select pg_stat_get_xact_blocks_fetched('ci_runs'::regclass)::integer as pages")).rows[0]!.pages
    return {
      async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
        // Backend counters can retain completed transactions until PostgreSQL flushes statistics.
        const before = await readPages()
        const result = await client.query<R>(text, values)
        try {
          const after = await readPages()
          fetched += Math.max(0, after - before)
          pages.max = Math.max(pages.max, fetched)
        } catch { /* ignore: a failed transaction already fails the measured read */ }
        return result
      },
      on: client.on.bind(client),
      removeListener: client.removeListener.bind(client),
      release: client.release.bind(client),
    }
  } } as unknown as pg.Pool
  return { pool: measured, pages }
}
