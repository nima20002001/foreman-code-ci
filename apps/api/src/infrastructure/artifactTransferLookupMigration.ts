export const artifactTransferLookupMigration = { version: 2026101501, sql: `
  create index management_command_transfer_idx
    on management_command_receipts(operation, (result->'intent'->>'transferId'));
` } as const
