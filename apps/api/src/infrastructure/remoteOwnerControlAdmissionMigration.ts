/** Freeze response admission on the ORIGINAL delivery attempt, not a second control ledger. */
export const remoteOwnerControlAdmissionMigration = { version: 285206, sql: `
alter table interaction_delivery_attempts add column remote_owner_control jsonb;
alter table interaction_delivery_attempts add column remote_owner_control_token text;
alter table interaction_delivery_attempts add column remote_owner_control_fence bigint;
alter table interaction_delivery_attempts add column remote_owner_control_generation bigint;
alter table interaction_delivery_attempts add constraint remote_owner_control_snapshot check (
  (remote_owner_control is null and remote_owner_control_token is null and remote_owner_control_fence is null and remote_owner_control_generation is null)
  or (jsonb_typeof(remote_owner_control)='object' and remote_owner_control->>'schemaVersion'='1'
    and remote_owner_control#>>'{action,kind}'='respond' and remote_owner_control#>>'{action,interactionId}'=interaction_id
    and remote_owner_control#>>'{native,sessionId}'=native_session_id and remote_owner_control#>>'{action,nativeInteractionId}'=native_request_id
    and length(remote_owner_control_token)>0 and remote_owner_control_fence>0 and remote_owner_control_generation>0) is true);
create function remote_owner_control_snapshot_immutable() returns trigger language plpgsql as $$
begin
  if old.remote_owner_control is not null then
    if tg_op='DELETE' then raise exception 'Original remote response admission must be retained.'; end if;
    if row(old.remote_owner_control,old.remote_owner_control_token,old.remote_owner_control_fence,old.remote_owner_control_generation,
           old.interaction_id,old.attempt,old.native_session_id,old.native_request_id,old.correlation_id)
      is distinct from row(new.remote_owner_control,new.remote_owner_control_token,new.remote_owner_control_fence,new.remote_owner_control_generation,
           new.interaction_id,new.attempt,new.native_session_id,new.native_request_id,new.correlation_id) then
      raise exception 'Original remote response admission is immutable.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger remote_owner_control_snapshot_immutable before update or delete on interaction_delivery_attempts
  for each row execute function remote_owner_control_snapshot_immutable();
` } as const
