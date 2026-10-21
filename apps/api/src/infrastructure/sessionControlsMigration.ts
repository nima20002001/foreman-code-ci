export const sessionControlsMigration = {
  version: 288601,
  sql: `create table conversation_session_controls (
    conversation_id text primary key references operator_conversations(id) on delete cascade,
    record jsonb not null
  );
  create table conversation_session_defaults (
    principal_id text not null,
    role text not null check(role in ('operator','agent')),
    subject text not null,
    profile_key text not null,
    record jsonb not null,
    primary key(principal_id,role,subject,profile_key)
  );`,
}
