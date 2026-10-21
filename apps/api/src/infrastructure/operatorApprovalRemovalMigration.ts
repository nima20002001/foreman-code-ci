export const operatorApprovalRemovalMigration = { version: 170026, sql: `
  -- Operator-routed approval authority no longer exists. Existing mutable and
  -- immutable selections fail safe to the human User handler. Every block is
  -- legacy-safe because some old databases marked early migrations while
  -- carrying only a subset of their final columns.
  do $$ begin
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='application_settings' and column_name='record') then
      update application_settings set record=jsonb_set(record,'{approvalHandler}','"user"'::jsonb),updated_at=now()
        where record->>'approvalHandler'='operator';
    end if;
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='application_setting_versions' and column_name='record') then
      update application_setting_versions set record=jsonb_set(record,'{approvalHandler}','"user"'::jsonb)
        where record->>'approvalHandler'='operator';
    end if;
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='workflows' and column_name='record') then
      update workflows set record=jsonb_set(record,'{approval,handler}','"user"'::jsonb)
        where record#>>'{approval,handler}'='operator';
    end if;
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='graph_drafts' and column_name='record') then
      update graph_drafts set record=jsonb_set(record,'{graph,approval,handler}','"user"'::jsonb),updated_at=now()
        where record#>>'{graph,approval,handler}'='operator';
    end if;
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='workflow_versions' and column_name='record') then
      update workflow_versions set record=case when record#>>'{approval,handler}'='operator'
        then jsonb_set(record,'{approval,handler}','"user"'::jsonb) else record end;
      update workflow_versions set record=jsonb_set(record,'{definition,approval,handler}','"user"'::jsonb)
        where record#>>'{definition,approval,handler}'='operator';
    end if;
  end $$;

  do $$ begin
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='runs' and column_name='record')
      and to_regclass('management_principals') is not null then
      update management_principals set revoked_at=coalesce(revoked_at,now())
        where id in (select record->>'authorizationPrincipalId' from runs where record#>>'{approval,handler}'='operator');
      update runs set record=jsonb_set(record,'{approval,handler}','"user"'::jsonb)
        where record#>>'{approval,handler}'='operator';
    end if;
  end $$;

  do $$ begin
    if exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='durable_interactions' and column_name='record') then
      if to_regclass('review_jobs') is not null then
        delete from review_jobs where interaction_id in
          (select id from durable_interactions where record#>>'{approval,handler}'='operator');
      end if;
      update durable_interactions set record=jsonb_set(record,'{approval,handler}','"user"'::jsonb),updated_at=now()
        where record#>>'{approval,handler}'='operator';
    end if;
  end $$;

  do $$ begin
    if to_regclass('operator_chat_credentials') is not null and to_regclass('operator_conversations') is not null
      and to_regclass('management_principals') is not null then
      update management_principals set revoked_at=coalesce(revoked_at,now())
        where id in (select credential.principal_id from operator_chat_credentials credential
          join operator_conversations conversation on conversation.id=credential.conversation_id
          where conversation.id like 'operator-review:%');
      delete from operator_conversations where id like 'operator-review:%';
    end if;
  end $$;
  drop table if exists interaction_command_receipts;
` } as const
