export const workflowChatMigration = {
  version: 2026102103,
  sql: `
    create table workflow_chat_channels (
      id text primary key, workspace_id text not null, workflow_id text not null unique,
      revision bigint not null default 0, next_sequence bigint not null default 1
    );
    create table workflow_chat_posts (
      id text primary key, channel_id text not null references workflow_chat_channels(id),
      sequence bigint not null, command_id text not null, principal_id text not null,
      input_hash text not null, record jsonb not null, source_event_key text, run_id text,
      unique(channel_id,sequence), unique(principal_id,command_id),
      unique(channel_id,source_event_key)
    );
    create table chat_delivery_commands (
      id text primary key, command_id text not null, principal_id text not null,
      workspace_id text, workflow_id text, channel_id text references workflow_chat_channels(id),
      post_id text references workflow_chat_posts(id), target_hash text not null,
      input_hash text not null, request jsonb not null, receipt jsonb not null,
      owner_admission text not null check(owner_admission in ('prepared','owner_admitted')),
      owner_binding jsonb not null default '{}'::jsonb,
      sequence bigserial unique, revision bigint not null default 1,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(principal_id,command_id)
    );
    create index chat_delivery_prepared_idx on chat_delivery_commands(sequence)
      where owner_admission='prepared' and receipt->>'state'='queued';
    create index chat_delivery_post_idx on chat_delivery_commands(post_id,sequence);
    create index chat_delivery_target_idx on chat_delivery_commands(target_hash,sequence);
    create table chat_control_commands (
      principal_id text not null, command_id text not null, input_hash text not null,
      request jsonb not null, receipt jsonb not null, owner_binding jsonb not null default '{}'::jsonb,
      primary key(principal_id,command_id)
    );
    create table workflow_chat_projection_pending (
      source_event_key text primary key, workspace_id text not null, workflow_id text not null,
      fact jsonb not null, created_at timestamptz not null default now()
    );
    create table workflow_chat_projection_keys (
      source_event_key text primary key, input_hash text not null,
      post_id text references workflow_chat_posts(id)
    );
    create table workflow_chat_projection_work (
      work_key text primary key, started_post_id text references workflow_chat_posts(id),
      finished_post_id text references workflow_chat_posts(id), blocker_hash text
    );
  `,
} as const
