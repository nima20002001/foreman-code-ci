import type pg from 'pg'

/** Commit notifications belong to the disposable fixture database. */
export async function remoteReviewChanges(pool: pg.Pool) {
  await pool.query(`create function remote_review_fixture_changed() returns trigger language plpgsql as $$
    begin
      perform pg_notify('remote_review_fixture_changed', '');
      return null;
    end;
  $$;
  create trigger remote_review_interaction_changed after insert or update on durable_interactions
    for each row execute function remote_review_fixture_changed();
  create trigger remote_review_execution_changed after insert or update on harness_executions
    for each row execute function remote_review_fixture_changed();
  create trigger remote_review_job_changed after insert or update on review_jobs
    for each row execute function remote_review_fixture_changed();`)
  const connection = await pool.connect()
  const listeners = new Set<() => void>()
  let failure: Error | undefined
  let closed = false
  const changed = () => { for (const listener of listeners) listener() }
  const failed = (error: Error) => { failure = error; changed() }
  connection.on('notification', changed)
  connection.on('error', failed)
  try {
    await connection.query('listen remote_review_fixture_changed')
  } catch (error) {
    connection.off('notification', changed)
    connection.off('error', failed)
    connection.release(true)
    throw error
  }
  return {
    assertHealthy() {
      if (failure) throw failure
      if (closed) throw new Error('Remote review change listener closed.')
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (failure || closed) listener()
      return () => { listeners.delete(listener) }
    },
    async close() {
      closed = true
      changed()
      try { await connection.query('unlisten remote_review_fixture_changed') }
      finally {
        connection.off('notification', changed)
        connection.off('error', failed)
        connection.release(!!failure)
        listeners.clear()
      }
    },
  }
}
