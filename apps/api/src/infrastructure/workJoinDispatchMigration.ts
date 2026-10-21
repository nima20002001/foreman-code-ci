export const workJoinDispatchMigration = { version: 269307, sql: String.raw`
create table run_work_join_dispatches (
  run_id text not null,
  activation_id text not null,
  source_activation_id text not null,
  primary key (run_id,activation_id),
  foreign key (run_id,activation_id) references run_work_activations(run_id,activation_id) on delete cascade,
  foreign key (run_id,source_activation_id) references run_work_activations(run_id,activation_id) on delete cascade
);
create function assert_work_join_dispatch() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from run_work_activations a
    where a.run_id=new.run_id and a.activation_id=new.activation_id and a.cause_kind='join')
    or not exists(select 1 from run_work_results x
      where x.run_id=new.run_id and x.activation_id=new.source_activation_id) then
    raise exception 'WORK_JOIN_DISPATCH_CONFLICT';
  end if;
  return null;
end $$;
create constraint trigger work_join_dispatch_evidence after insert on run_work_join_dispatches
  deferrable initially deferred for each row execute function assert_work_join_dispatch();
create function protect_work_join_dispatch() returns trigger language plpgsql as $$
begin raise exception 'WORK_JOIN_DISPATCH_IMMUTABLE'; end $$;
create trigger work_join_dispatch_no_update before update on run_work_join_dispatches
  for each row execute function protect_work_join_dispatch();
` } as const
