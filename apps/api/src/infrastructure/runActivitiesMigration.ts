/** FLOW-04: an approval outcome is not a worker acknowledgement. Emit the
 * latter only when its original native receipt is committed. */
export const runActivitiesMigration = { version: 269501, sql: String.raw`
create function record_workflow_worker_ack_activity() returns trigger language plpgsql as $$
begin
  if new.approval_native_ack_id is not null and old.approval_native_ack_id is null then
    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values(new.run_id,'backend','interaction_worker_ack',new.execution_id,clock_timestamp(),
        jsonb_build_object('interactionId',new.interaction_id,
          'acknowledgementId',new.approval_native_ack_id));
  end if;
  return new;
end $$;
create trigger workflow_worker_ack_activity after update of approval_native_ack_id
  on interaction_graph_resumes for each row execute function record_workflow_worker_ack_activity();
create unique index run_activity_worker_ack_once on run_activity(run_id,(payload->>'interactionId'))
  where kind='interaction_worker_ack';
create unique index run_activity_reactivation_once on run_activity(run_id,(payload->>'activationId'))
  where kind='work_requester_reactivated';
create unique index run_activity_reroute_once on run_activity(run_id,(payload->>'requestId'))
  where kind='work_rerouted';
` } as const
