/** FIL-36. Register after fileStorageMigration (273601); migrations.ts is deliberately untouched. */
export const fileReferenceMigration = {
  version: 273636,
  sql: `
    create function file_reference_immutable_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'DELETE' then
        if old.scope_kind in ('workflow_reference','workspace_reference') then
          raise exception 'Permanent reference removal must retain its tombstone.';
        end if;
        return old;
      end if;
      if old.scope_kind <> 'temporary' or new.scope_kind <> 'temporary' then
        if row(old.file_id,old.owner_principal_id,old.current_revision_id,old.scope_kind,
               old.chat_kind,old.operator_id,old.conversation_id,old.agent_id,old.workspace_id,
               old.workflow_id,old.run_id,old.execution_id,old.created_at)
          is distinct from
           row(new.file_id,new.owner_principal_id,new.current_revision_id,new.scope_kind,
               new.chat_kind,new.operator_id,new.conversation_id,new.agent_id,new.workspace_id,
               new.workflow_id,new.run_id,new.execution_id,new.created_at) then
          raise exception 'Permanent reference identity, scope and pinned revision are immutable.';
        end if;
        if (old.state = 'removed' and new.state <> 'removed')
          or (old.state = 'ready' and new.state = 'pending') then
          raise exception 'Permanent references cannot be resurrected or overwritten.';
        end if;
      end if;
      return new;
    end $$;
    create trigger file_reference_immutable_identity before update or delete on files
      for each row execute function file_reference_immutable_identity();
  `,
} as const
