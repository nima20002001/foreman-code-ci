export const deviceManagedMcpMigration = { version: 2026101451, sql: `
  alter table harness_mcp_change_plans add column host_ref jsonb;
  alter table harness_mcp_change_plans drop constraint if exists harness_mcp_change_plans_harness_check;
  alter table harness_mcp_change_plans add constraint harness_mcp_change_plans_harness_check
    check (harness in ('codex', 'claude', 'opencode'));
` } as const
