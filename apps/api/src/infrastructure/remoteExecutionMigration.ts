/** Main-owned receipt/observation evidence; worker processes never connect to this database. */
export const remoteExecutionMigration = { version: 284401, sql: String.raw`
create table remote_execution_owner_reconciliations (
  operation_id text not null references execution_dispatch_intents(operation_id),
  command_id text primary key, ordinal bigint generated always as identity,
  transition jsonb not null check(jsonb_typeof(transition)='object'),
  check(transition->>'operationId'=operation_id and transition->>'commandId'=command_id)
);
create table remote_execution_receipts (
  operation_id text primary key references execution_dispatch_intents(operation_id),
  sequence bigint not null check(sequence>0),
  receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  check(receipt->>'schemaVersion'='1' and receipt#>>'{intent,operationId}'=operation_id
    and (receipt->>'sequence')::bigint=sequence)
);
create table remote_execution_recovery_audit (
  operation_id text not null references execution_dispatch_intents(operation_id),
  ordinal bigint generated always as identity,
  reason text not null check(length(reason)<=100),
  evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
  primary key(operation_id,ordinal)
);
` } as const
