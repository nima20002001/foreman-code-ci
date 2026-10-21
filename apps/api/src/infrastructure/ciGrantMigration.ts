/** CI start moved from the job/source grant set to the single ci action; grants that could start CI keep it. */
export const ciGrantMigration = { version: 2026101350, sql: `
  update management_principals p
    set grants=(select jsonb_agg(case when g->'actions' ? 'jobs:start' and not g->'actions' ? 'ci'
        then jsonb_set(g, '{actions}', (g->'actions') || '["ci"]'::jsonb) else g end order by n)
      from jsonb_array_elements(p.grants) with ordinality e(g, n))
    where exists (select 1 from jsonb_array_elements(p.grants) g
      where g->'actions' ? 'jobs:start' and not g->'actions' ? 'ci');
` } as const
