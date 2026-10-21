/** Original input admission uses the existing canonical command ledger. */
export const jobInputAdmissionMigration = { version: 285204, sql: `
create unique index job_input_admission_recipient_idx on management_command_receipts((result #>> '{manifest,recipient,executionId}'),(result #>> '{manifest,recipient,attemptId}')) where operation='job.inputs.bind';
create function job_input_admission_immutable() returns trigger language plpgsql as $$ begin
 if old.operation='job.inputs.bind' then raise exception 'Original job input bindings are immutable.'; end if;
 if tg_op='UPDATE' and new.operation='job.inputs.bind' then raise exception 'Job input binding requires original admission.'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger job_input_admission_immutable before update or delete on management_command_receipts for each row execute function job_input_admission_immutable();
` } as const
