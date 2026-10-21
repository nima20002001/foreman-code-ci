/** Binary compatibility is shared; native host measurements retain their own identity and result. */
export const hostHarnessMeasurementsMigration = { version: 2026100603, sql: `
  create table if not exists host_harness_measurements (
    identity_hash text primary key,
    harness text not null,
    binary_sha256 text not null,
    suite_revision text not null,
    qualification jsonb not null,
    evidence jsonb not null
  );
  create index if not exists host_harness_measurements_binary on host_harness_measurements(harness,binary_sha256,suite_revision);
  insert into host_harness_measurements
    select encode(sha256(convert_to((evidence->'qualificationIdentity')::text,'utf8')),'hex'),
      harness,binary_sha256,suite_revision,
      jsonb_build_object('harness',harness,'version',version,'binarySha256',binary_sha256,
        'suiteRevision',suite_revision,'profile',profile,'status',case when status='passed' then 'qualified' else status end,
        'checks',checks,'failureReason',failure_reason,
        'startedAt',to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'checkedAt',to_char(checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),evidence
    from harness_qualifications where jsonb_typeof(evidence->'qualificationIdentity')='object'
    on conflict (identity_hash) do nothing;
` } as const
