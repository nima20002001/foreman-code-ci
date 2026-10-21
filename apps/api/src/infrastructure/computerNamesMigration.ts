/** Owner-given computer names, one per Main or paired computer; a computer without a row keeps its default label. */
export const computerNamesMigration = { version: 2026101704, sql: `
create table computer_names (
 host_key text primary key, name text not null check (char_length(name) between 1 and 60),
 updated_by text not null references management_principals(id)
);
` } as const
