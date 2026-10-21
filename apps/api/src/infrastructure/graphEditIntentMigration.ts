/** New migration; do not append DDL to a migration already recorded as applied. */
export const graphEditIntentMigration = {
  version: 264201,
  sql: `
    create table graph_edit_intents (
      id text primary key,
      principal_id text not null references management_principals(id),
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      draft_id text not null,
      state text not null check (state in ('staged','stopping','waiting','saving','blocked','uncertain','saved','discarded')),
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((record->>'id'=id and record->>'ownerPrincipalId'=principal_id
        and record->>'workspaceId'=workspace_id and record->>'workflowId'=workflow_id
        and record->>'draftId'=draft_id and record->>'state'=state) is true)
    );
    create unique index graph_edit_intents_one_open
      on graph_edit_intents(principal_id,workspace_id,workflow_id)
      where state not in ('saved','discarded');
    create index graph_edit_intents_owner_scope
      on graph_edit_intents(principal_id,workspace_id,workflow_id,created_at desc,id);
    -- Draft IDs are historical identities, deliberately not cascading FKs.
    -- Payload and command identities are immutable even after discard.
    create function protect_graph_edit_intent() returns trigger language plpgsql as $$
    begin
      if (new.record - array['state','stops','result','error','updatedAt','saveAttempted'])
           is distinct from (old.record - array['state','stops','result','error','updatedAt','saveAttempted'])
        or new.id<>old.id or new.principal_id<>old.principal_id or new.workspace_id<>old.workspace_id
        or new.workflow_id<>old.workflow_id or new.draft_id<>old.draft_id or new.created_at<>old.created_at then
        raise exception 'graph edit intent identities and payload are immutable';
      end if;
      if old.state in ('saved','discarded') and new.record is distinct from old.record then
        raise exception 'terminal graph edit intent is immutable';
      end if;
      if old.record->'saveAttempted'='true'::jsonb and new.record->'saveAttempted' is distinct from 'true'::jsonb then
        raise exception 'graph edit intent cannot forget a save attempt';
      end if;
      if exists (
        select 1 from jsonb_array_elements(old.record->'stops') with ordinality o(value,n)
        full join jsonb_array_elements(new.record->'stops') with ordinality n(value,n) using(n)
        where o.value is null or n.value is null
          or o.value-'receipt' is distinct from n.value-'receipt'
          or (o.value ? 'receipt' and o.value->'receipt' is distinct from n.value->'receipt')
      ) then raise exception 'exact Stop journal cannot be replaced'; end if;
      return new;
    end $$;
    create trigger graph_edit_intents_immutable before update on graph_edit_intents
      for each row execute function protect_graph_edit_intent();
  `,
} as const
