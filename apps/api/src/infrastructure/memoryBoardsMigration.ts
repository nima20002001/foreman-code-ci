/** Team D assigns the version and registers this migration in dependency order. */
export const memoryBoardsMigration = { sql: `
create table memory_boards (
  id text primary key, scope_key text not null unique, scope jsonb not null,
  revision bigint not null default 0, sequence bigint not null default 0,
  counts jsonb not null default '{"todo":0,"doing":0,"blocked":0,"done":0,"completed":0,"dropped":0,"notes":0}',
  next_note_rank bigint not null default 0
);
create table memory_cards (
  id text primary key, board_id text not null references memory_boards(id),
  normalized_title text collate "C" not null, status text not null,
  completion_kind text, updated_at text not null, record jsonb not null, blocker_source text,
  unique(board_id, normalized_title),
  check(status in ('todo','doing','blocked','done')),
  check((status='done')=(completion_kind is not null))
);
create index memory_cards_recent on memory_cards(board_id,status,updated_at desc,id desc);
create index memory_cards_outcome_recent on memory_cards(board_id,status,completion_kind,updated_at desc,id desc);
create index memory_cards_prefix on memory_cards(board_id,status,normalized_title collate "C",id);
create index memory_cards_outcome_prefix on memory_cards(board_id,status,completion_kind,normalized_title collate "C",id);
create index memory_cards_open_recent on memory_cards(board_id,updated_at desc,id desc) where status<>'done';
create table memory_card_targets (
  board_id text not null references memory_boards(id), card_id text not null references memory_cards(id),
  target_key text not null, updated_at text not null, primary key(card_id,target_key)
);
create index memory_card_targets_recent on memory_card_targets(board_id,target_key,updated_at desc,card_id desc);
create table memory_notes (
  id text primary key, board_id text not null references memory_boards(id),
  archived boolean not null, rank bigint not null, record jsonb not null
);
create index memory_notes_page on memory_notes(board_id,archived,rank,id);
create table memory_card_bindings (
  id text primary key, board_id text not null references memory_boards(id),
  card_id text not null references memory_cards(id), work_key text not null,
  node_key text not null, record jsonb not null, unique(card_id,work_key)
);
create index memory_bindings_work on memory_card_bindings(work_key,board_id,card_id);
create table memory_card_claims (
  id text primary key, board_id text not null references memory_boards(id),
  card_id text not null references memory_cards(id), node_key text not null,
  state text not null, record jsonb not null
);
create unique index memory_claims_armed on memory_card_claims(card_id,node_key) where state='armed';
create index memory_claims_node on memory_card_claims(node_key,state,board_id);
create index memory_claims_card on memory_card_claims(card_id,id);
create table memory_board_commands (
  principal_id text not null, command_id text not null, board_id text not null references memory_boards(id),
  input_hash text not null, receipt jsonb, rejection jsonb, primary key(principal_id,command_id),
  check((receipt is null) <> (rejection is null))
);
create table memory_board_effects (
  effect_key text primary key, input_hash text not null, receipt jsonb not null
);
create table memory_board_changes (
  board_id text not null references memory_boards(id), sequence bigint not null,
  entity_id text not null, record jsonb not null, primary key(board_id,sequence)
);
create index memory_changes_entity on memory_board_changes(board_id,entity_id,sequence desc);
` } as const
