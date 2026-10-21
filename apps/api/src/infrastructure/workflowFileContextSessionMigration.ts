/** File contexts retain per-execution facts; only interactive chats own a native thread. */
export const workflowFileContextSessionMigration = { version: 2026101806, sql: `
  drop index operator_conversations_native_session_idx;
  create unique index operator_conversations_native_session_idx
    on operator_conversations (harness,native_session_id)
    where native_session_id is not null
      and coalesce(agent_key,'') not like 'workflow-native-files:v1:%';
` } as const
