export const claudeCallbackMigration = {
  version: 2026100501,
  sql: `create table claude_callback_receipts (
    owner_key text not null,
    callback_key text not null,
    input_hash text not null,
    record jsonb not null,
    primary key(owner_key,callback_key)
  );
  create index claude_callback_tool_idx on claude_callback_receipts(owner_key,
    (record#>>'{identity,nativeSessionId}'),(record#>>'{identity,nativeMessageId}'),
    (record#>>'{identity,generation}'),(record#>>'{identity,toolUseId}'));`,
}
