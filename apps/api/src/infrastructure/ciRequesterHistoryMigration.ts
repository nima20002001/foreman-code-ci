export const ciRequesterHistoryMigration = { version: 2026101602, sql: `
  create index ci_runs_requester_history_idx
    on ci_runs(workspace_id,(record#>>'{initiator,principalId}'),created_at desc) include(group_id);
` } as const
