/** Builds use one priority order. Saved Primary/Backup roles fold into it: on each Main, computers keep their
 * previous order (every Primary before any Backup, then priority) as priorities 100, 99, … before the role is dropped. */
export const buildComputerPriorityMigration = { version: 2026100860, sql: `
with ranked as (
  select host_key, row_number() over (partition by target->'hostRef'->>'mainId'
    order by (build_role = 'backup'), build_priority desc, host_key) - 1 as position
  from build_computer_preferences
  where target->'hostRef'->>'mainId' in (select target->'hostRef'->>'mainId' from build_computer_preferences where build_role = 'backup')
)
update build_computer_preferences preference
  set build_priority = greatest(0, 100 - ranked.position), revision = preference.revision + 1
  from ranked
  where preference.host_key = ranked.host_key and preference.build_priority <> greatest(0, 100 - ranked.position);
alter table build_computer_preferences drop column build_role;
` }
