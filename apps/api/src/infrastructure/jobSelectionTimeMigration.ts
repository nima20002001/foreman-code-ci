export const jobSelectionTimeMigration = { version: 285802, sql: `
alter table job_computer_selections add column claimed_at timestamptz;
alter table job_computer_selections alter column claimed_at set default clock_timestamp();
` }
