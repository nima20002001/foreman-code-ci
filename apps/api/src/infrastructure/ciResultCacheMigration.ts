/** Non-gate affected CI runs skip a test file that an earlier passed ticket ran with identical inputs. Each run keeps
 * the input key of every file it was sent, so a finished passed run records the files it proved. */
export const ciResultCacheMigration = { version: 2026101330, sql: `
  create table ci_test_result_cache (
    workspace_id text not null references workspaces(id),
    repository text not null,
    cache_key text not null,
    file text not null,
    ticket_id uuid not null,
    commit text not null,
    passed_at timestamptz not null default now(),
    primary key (workspace_id, repository, cache_key)
  );
  alter table ci_runs add column result_cache_keys jsonb;
` } as const
