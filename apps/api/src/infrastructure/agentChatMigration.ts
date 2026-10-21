/**
 * FEAT-15 selected-Agent chat reuses the Operator conversation tables (NIM-2682).
 * Agent rows carry workspace/workflow/node/Agent linkage and never an Operator or owner.
 * Turn receipts gain an intent, a delivery state and a server order.
 */
export const agentChatMigration = {
  version: 268201,
  sql: `
    alter table operator_conversations alter column operator_id drop not null;
    alter table operator_conversations alter column operator_configuration_version_id drop not null;
    alter table operator_conversations add column kind text not null default 'operator';
    alter table operator_conversations add column agent_key text;
    alter table operator_conversations add column workspace_id text references workspaces(id);
    alter table operator_conversations add column workflow_id text;
    alter table operator_conversations add column workflow_node_id text;
    alter table operator_conversations add column agent_id text references agents(id);
    alter table operator_conversations add column agent_configuration_version_id text references agent_configuration_versions(id);
    alter table operator_conversations add column origin_run_id text references runs(id);
    alter table operator_conversations add column origin_execution_id text references harness_executions(id);
    alter table operator_conversations add constraint operator_conversations_kind_check check (
      (kind = 'operator' and operator_id is not null and operator_configuration_version_id is not null and agent_key is null)
      or (kind = 'agent' and operator_id is null and owner_principal_id is null and agent_key is not null
        and workspace_id is not null and workflow_id is not null and workflow_node_id is not null
        and agent_id is not null and agent_configuration_version_id is not null
        and (origin_run_id is null) = (origin_execution_id is null)));
    create unique index operator_conversations_agent_key_idx on operator_conversations (agent_key)
      where kind = 'agent' and deleted_at is null;

    alter table operator_conversation_turns add column turn_sequence bigint generated always as identity;
    alter table operator_conversation_turns add column intent text;
    alter table operator_conversation_turns add column delivery text;
    alter table operator_conversation_turns add column message_id text;
    alter table operator_conversation_turns add column native_turn_id text;
    alter table operator_conversation_turns add column target_native_turn_id text;
    alter table operator_conversation_turns add column delivery_error jsonb;
    alter table operator_conversation_turns add column created_at timestamptz not null default now();
    alter table operator_conversation_turns add column updated_at timestamptz not null default now();
    alter table operator_conversation_turns add constraint operator_turns_agent_delivery_check check (
      (intent is null and delivery is null)
      or (intent in ('next_turn','steer','interrupt_and_send')
        and delivery in ('queued','submitting','accepted','completed','failed','canceled','unknown')
        and message_id is not null));
    create index operator_turns_agent_open_idx on operator_conversation_turns (conversation_id, turn_sequence)
      where delivery in ('queued','submitting','accepted','unknown');
  `,
} as const
