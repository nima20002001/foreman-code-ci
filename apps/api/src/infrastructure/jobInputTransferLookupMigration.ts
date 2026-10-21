export const jobInputTransferLookupMigration = { version: 2026101505, sql: `
  create index job_input_admission_transfers_idx
    on management_command_receipts using gin ((result->'transfers') jsonb_path_ops)
    where operation='job.inputs.bind';
` } as const
