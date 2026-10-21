export const conversationCredentialsMigration = { version: 2026102121, sql: String.raw`
create table agent_conversation_credentials (
  principal_id text primary key references management_principals(id),
  conversation_id text not null references operator_conversations(id),
  subject jsonb not null,
  workflow_version_id text not null references workflow_versions(id),
  created_at timestamptz not null default now()
);
create index agent_conversation_credentials_owner on agent_conversation_credentials(conversation_id);
` } as const
