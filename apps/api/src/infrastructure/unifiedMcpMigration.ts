/** One GraphQL MCP entry serves every role. Worker bindings record the shared credential
 * variable, and managed plans can install the unified `graphql` preset. History keeps the
 * retired operator/worker presets readable. */
export const unifiedMcpMigration = { version: 264701, sql: `
  alter table worker_credential_bindings drop constraint worker_credential_bindings_environment_variable_check;
  update worker_credential_bindings set environment_variable='GRAPHQL_MCP_TOKEN' where environment_variable='GRAPHQL_APP_MCP_TOKEN';
  alter table worker_credential_bindings add constraint worker_credential_bindings_environment_variable_check
    check (environment_variable = 'GRAPHQL_MCP_TOKEN');
  alter table harness_mcp_change_plans drop constraint harness_mcp_change_plans_managed_preset_check;
  alter table harness_mcp_change_plans add constraint harness_mcp_change_plans_managed_preset_check
    check (managed_preset in ('graphql', 'linear', 'operator', 'worker'));
` } as const
