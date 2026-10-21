/** Freeze original Main-owned workflow file context in existing ledgers/rows. */
export const remoteNativeArtifactContextMigration = { version: 285207, sql: `
create unique index remote_native_artifact_context_slot_idx on management_command_receipts(target_key)
  where operation='remote.native-artifact.context';
create or replace function remote_native_artifact_output_immutable() returns trigger language plpgsql as $$
begin
  if old.operation in ('remote.native-artifact.output','remote.native-artifact.context') then
    raise exception 'Original native artifact receipts are immutable.';
  end if;
  if tg_op='UPDATE' and new.operation in ('remote.native-artifact.output','remote.native-artifact.context') then
    raise exception 'Native artifact receipts require their original command insertion.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create function workflow_native_file_context_immutable() returns trigger language plpgsql as $$
begin
  if old.agent_key like 'workflow-native-files:v1:%' then
    if tg_op='DELETE' then raise exception 'Original workflow file contexts must be retained.'; end if;
    if row(old.id,old.kind,old.agent_key,old.operator_id,old.operator_configuration_version_id,old.owner_principal_id,
           old.workspace_id,old.workflow_id,old.workflow_node_id,old.agent_id,old.agent_configuration_version_id,
           old.origin_run_id,old.origin_execution_id,old.harness,old.provider_version,old.native_session_id,
           old.record)
      is distinct from row(new.id,new.kind,new.agent_key,new.operator_id,new.operator_configuration_version_id,new.owner_principal_id,
           new.workspace_id,new.workflow_id,new.workflow_node_id,new.agent_id,new.agent_configuration_version_id,
           new.origin_run_id,new.origin_execution_id,new.harness,new.provider_version,new.native_session_id,
           new.record) then
      raise exception 'Original workflow file context identity is immutable.';
    end if;
  elsif tg_op='UPDATE' and new.agent_key like 'workflow-native-files:v1:%' then
    raise exception 'Workflow file contexts require their original Main admission insertion.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger workflow_native_file_context_immutable before update or delete on operator_conversations
  for each row execute function workflow_native_file_context_immutable();
` } as const
