import { DatabaseSync } from 'node:sqlite'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { recoverSubagentCommands } from './recovery.js'

it('startup preserves terminal backfills and resets only unfinished native executions', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`
      create table harness_executions(id text primary key, record text);
      create table run_subagent_backfill_state(execution_id text primary key, complete boolean, child_cursor text);
      insert into harness_executions values
        ('finished', '{"state":"completed"}'), ('running', '{"state":"running"}'),
        ('waiting', '{"state":"waiting"}'), ('partial', '{"state":"completed"}');
      insert into run_subagent_backfill_state values
        ('finished', true, null), ('running', true, null),
        ('waiting', false, 'live-page'), ('partial', false, 'saved-page');
    `)
    // Other startup recovery operations are independent of the backfill store.
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockImplementationOnce(async (statement: string) => {
        database.exec(statement)
        return { rows: [], rowCount: 0 }
      })
    expect(await recoverSubagentCommands({ query } as unknown as pg.Pool)).toBe(2)
    const rows = database.prepare(`select execution_id,complete,child_cursor
      from run_subagent_backfill_state order by execution_id`).all()
    expect(rows).toEqual([
      { execution_id: 'finished', complete: 1, child_cursor: null },
      { execution_id: 'partial', complete: 0, child_cursor: 'saved-page' },
      { execution_id: 'running', complete: 0, child_cursor: null },
      { execution_id: 'waiting', complete: 0, child_cursor: null },
    ])
  } finally {
    database.close()
  }
})
