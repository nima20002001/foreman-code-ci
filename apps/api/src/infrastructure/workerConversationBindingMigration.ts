export const workerConversationBindingMigration = {
  version: 288603,
  sql: `alter table operator_conversations add column worker_conversation_binding jsonb;`,
}
