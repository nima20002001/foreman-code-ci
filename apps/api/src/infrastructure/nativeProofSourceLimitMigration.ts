// Native proof records hold one captured native source, which the capture path admits up to
// REMOTE_NATIVE_SOURCE_LIMIT (3 x 4 MiB). The original 4 MiB check rejected valid long-session
// history sources and left reconciliation retrying the same insert forever.
export const nativeProofSourceLimitMigration = { version: 2026101013, sql: `
  alter table workflow_native_proofs drop constraint workflow_native_proofs_record_json_check;
  alter table workflow_native_proofs add constraint workflow_native_proofs_record_json_check check(octet_length(record_json)<=12582912);
  alter table review_native_proofs drop constraint review_native_proofs_record_json_check;
  alter table review_native_proofs add constraint review_native_proofs_record_json_check check(octet_length(record_json)<=12582912);
` } as const
