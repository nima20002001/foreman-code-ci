/** Adds the Waiting for user card status: an Agent needs the owner to act before work can continue. */
export const memoryWaitingForUserMigration = { version: 2026102160, sql: `
do $$
declare name text;
begin
  for name in select conname from pg_constraint
    where conrelid='memory_cards'::regclass and contype='c' and pg_get_constraintdef(oid) like '%doing%'
  loop execute format('alter table memory_cards drop constraint %I', name); end loop;
end $$;
alter table memory_cards add constraint memory_cards_status_check
  check(status in ('todo','doing','waiting_for_user','blocked','done'));
alter table memory_boards alter column counts set default
  '{"todo":0,"doing":0,"waiting_for_user":0,"blocked":0,"done":0,"completed":0,"dropped":0,"notes":0}';
update memory_boards set counts=counts||'{"waiting_for_user":0}' where not counts ? 'waiting_for_user';
` }
