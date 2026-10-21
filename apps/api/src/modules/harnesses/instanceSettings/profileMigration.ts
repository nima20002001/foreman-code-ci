/** Supplements immutable instance settings with exact-profile native evidence, never credentials. */
export const harnessInstanceProfileEvidenceMigration = { version: 283402, sql: `
create table harness_instance_profile_evidence (
 check_id uuid primary key, instance_id uuid not null, instance_revision bigint not null,
 record jsonb not null, created_at timestamptz not null default now(),
 foreign key(instance_id, instance_revision) references harness_instance_settings(instance_id, revision)
);
create index harness_instance_profile_evidence_instance_idx on harness_instance_profile_evidence(instance_id,instance_revision,created_at desc);
` } as const
