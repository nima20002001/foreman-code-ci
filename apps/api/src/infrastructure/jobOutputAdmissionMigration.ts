/** Adds indexes/immutability to the EXISTING command receipt ledger; no parallel transfer/event store. */
export const jobOutputAdmissionMigration = { version: 285203, sql: `
create unique index job_output_admission_transfer_idx on management_command_receipts((result #>> '{intent,transferId}')) where operation='job.output.admit';
create unique index job_output_admission_slot_idx on management_command_receipts((result #>> '{input,executionId}'),(result #>> '{input,attemptId}'),(result #>> '{input,path}')) where operation='job.output.admit';
create function job_output_admission_immutable() returns trigger language plpgsql as $$ begin
 if old.operation='job.output.admit' then raise exception 'Original job output admission receipts are immutable.'; end if;
 if tg_op='UPDATE' and new.operation='job.output.admit' then raise exception 'Job output admission requires its original command insertion.'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger job_output_admission_immutable before update or delete on management_command_receipts for each row execute function job_output_admission_immutable();
` } as const
