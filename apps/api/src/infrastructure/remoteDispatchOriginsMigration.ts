/** Main-owned durable correlation before request delivery; workers receive no SQL authority. */
export const remoteDispatchOriginsMigration = { version: 284501, sql: `
create table remote_dispatch_origins (
 operation_id text primary key references execution_dispatch_intents(operation_id),
 connection jsonb not null, bound_at timestamptz not null default now(),
 check(jsonb_typeof(connection)='object')
);
create function remote_dispatch_origin_immutable() returns trigger language plpgsql as $$
begin raise exception 'Original remote dispatch connection is immutable.' using errcode='P2845'; end $$;
create trigger remote_dispatch_origin_no_rebind before update or delete on remote_dispatch_origins
 for each row execute function remote_dispatch_origin_immutable();
create trigger remote_dispatch_origin_no_truncate before truncate on remote_dispatch_origins
 for each statement execute function remote_dispatch_origin_immutable();
` } as const
