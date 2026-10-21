/** A finished test run's structured results (bounded by CiTestResultsSchema), read with its ticket. */
export const ciTestResultsMigration = { version: 2026101210, sql: `
  alter table ci_runs add column test_results jsonb;
` } as const
