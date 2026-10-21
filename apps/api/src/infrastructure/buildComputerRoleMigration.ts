/** A build computer is a primary or a backup, and lends at most this share of its CPU and memory to builds. */
export const buildComputerRoleMigration = { version: 2026100606, sql: `
alter table build_computer_preferences
  add column if not exists build_role text not null default 'primary' check (build_role in ('primary','backup')),
  add column if not exists build_allowance_percent integer not null default 100 check (build_allowance_percent between 10 and 100);
` }
