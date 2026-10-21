export const commandReceiptRetentionMigration = { version: 2026101607, sql: `
  create index management_receipts_retention_idx
    on management_command_receipts(operation,created_at,principal_id,command_id);
  create index management_audit_command_retry_idx
    on management_audit(principal_id,action,(details->>'commandId'),occurred_at desc)
    where outcome='succeeded' or details->>'phase'='reserved';
` } as const
