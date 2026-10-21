/** BE-001 restart receipts. Additive: no historical closure/finalization backfill. */
export const workflowClosureMigration = {
  version: 264401,
  sql: `
    create table execution_native_closures (
      generation bigint generated always as identity primary key,
      execution_id text not null references harness_executions(id) on delete cascade,
      execution_identity jsonb not null check (jsonb_typeof(execution_identity)='object'),
      expected_reference jsonb,
      closed_reference jsonb,
      closed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      check ((closed_at is null) = (closed_reference is null)),
      check (expected_reference is null or jsonb_typeof(expected_reference)='object'),
      check (closed_reference is null or jsonb_typeof(closed_reference)='object')
    );
    create index execution_native_closures_latest_idx
      on execution_native_closures(execution_id,generation desc);

    -- A new lifetime gets a new row. No code can rewrite the identity, move an
    -- observed close to another generation, or retract/change a positive receipt.
    create function immutable_execution_native_closure() returns trigger language plpgsql as $$
    begin
      if NEW.generation is distinct from OLD.generation
        or NEW.execution_id is distinct from OLD.execution_id
        or NEW.execution_identity is distinct from OLD.execution_identity
        or NEW.expected_reference is distinct from OLD.expected_reference
        or NEW.created_at is distinct from OLD.created_at
        or (OLD.closed_at is not null and
          (NEW.closed_at is distinct from OLD.closed_at or NEW.closed_reference is distinct from OLD.closed_reference)) then
        raise exception 'NATIVE_WORKFLOW_CLOSURE_IMMUTABLE' using errcode='P2644';
      end if;
      return NEW;
    end $$;
    create trigger execution_native_closure_immutable before update on execution_native_closures
      for each row execute function immutable_execution_native_closure();
  `,
} as const
