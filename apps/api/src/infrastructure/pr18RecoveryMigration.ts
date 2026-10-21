/** Additive acceptance and recovery evidence; contains no native credentials. */
export const pr18RecoveryMigration = {
  version: 170022,
  sql: `
    alter table harness_mcp_change_plans add column native_user_after_hash text;
    alter table harness_mcp_change_plans add column native_file text;
    alter table harness_mcp_change_plans add column reconciled_revision text;
    alter table harness_mcp_change_plans drop constraint harness_mcp_change_plans_status_check;
    alter table harness_mcp_change_plans add constraint harness_mcp_change_plans_status_check
      check (status in ('pending','submitting','applied','rejected','failed','uncertain','reconciled'));
    alter table operator_conversation_turns add column operator_configuration_version_id text
      references operator_configuration_versions(id);
    -- An active turn's conversation pin is authoritative. Historical unpinned
    -- retries cannot be backfilled from today's defaults or a later turn.
    update operator_conversation_turns t set operator_configuration_version_id=c.operator_configuration_version_id
      from operator_conversations c where t.conversation_id=c.id and t.request_id=c.active_request_id;
  `,
}
