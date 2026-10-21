export const localWorkflowNativeOutputMigration = { version: 285210, sql: String.raw`
create table local_workflow_native_outputs (
  artifact_id uuid primary key,
  main_id uuid not null,
  execution_id text not null references harness_executions(id),
  binding text not null check(binding ~ '^[a-f0-9]{64}$'),
  description jsonb not null,
  byte_size integer not null default 0 check(byte_size between 0 and 67108864),
  sha256 text check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  publication jsonb,
  retired_at timestamptz
);
create index local_workflow_native_outputs_execution on local_workflow_native_outputs(execution_id);
create table local_workflow_native_output_chunks (
  artifact_id uuid not null references local_workflow_native_outputs(artifact_id),
  byte_offset integer not null check(byte_offset between 0 and 67108864),
  bytes bytea not null check(octet_length(bytes) between 1 and 65536),
  primary key(artifact_id,byte_offset)
);
create table local_workflow_native_output_commands (
  execution_id text not null references harness_executions(id),
  binding text not null check(binding ~ '^[a-f0-9]{64}$'),
  command_id text not null,
  input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
  reply jsonb,
  primary key(binding,command_id)
);
` } as const
