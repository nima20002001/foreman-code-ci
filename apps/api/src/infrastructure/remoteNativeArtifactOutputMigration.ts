/** W08 binds one native output slot to the original canonical W09 publication.
 * Reuse command receipts; canonical bytes/publication authority remain in their existing ledgers.
 * target_key is JSON.stringify([mainId, executionId, attemptId, outputKey]), where mainId
 * comes from the original verified transfer receipt. The adapter owns record validation.
 */
export const remoteNativeArtifactOutputMigration = { version: 285205, sql: `
create unique index remote_native_artifact_output_slot_idx on management_command_receipts(target_key)
  where operation='remote.native-artifact.output';
create function remote_native_artifact_output_immutable() returns trigger language plpgsql as $$
begin
  if old.operation='remote.native-artifact.output' then
    raise exception 'Original native artifact output bindings are immutable.';
  end if;
  if tg_op='UPDATE' and new.operation='remote.native-artifact.output' then
    raise exception 'Native artifact output bindings require their original command insertion.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger remote_native_artifact_output_immutable before update or delete on management_command_receipts
  for each row execute function remote_native_artifact_output_immutable();
` } as const
