export const retiredHarnessCredentialsMigration = {
  version: 2026100861,
  sql: `
    insert into application_settings (key, record, revision, updated_at)
    select 'retired-harness-defaults', jsonb_build_object('opencode', record->'opencode'), revision, now()
    from application_settings
    where key = 'harness-defaults' and record ? 'opencode'
    on conflict (key) do nothing;

    insert into application_settings (key, record, revision, updated_at)
    select 'retired-harness-unavailable', record, revision, now()
    from application_settings
    where key = 'harness-default-model-unavailable' and record @> '["opencode"]'::jsonb
    on conflict (key) do nothing;

    update application_settings
    set record = record - 'opencode', revision = revision + 1, updated_at = now()
    where key = 'harness-default-model-unavailable' and record @> '["opencode"]'::jsonb;

    do $retire_defaults$
    declare
      saved application_settings%rowtype;
      revised jsonb;
      role_name text;
      replacement jsonb := '{"harness":"codex","model":"gpt-5.6-luna","reasoningEffort":"medium",
        "sandbox":"read-only","serviceTier":"standard"}'::jsonb;
      version_id text;
    begin
      select * into saved from application_settings where key = 'agent-defaults-v1' for update;
      if not found then return; end if;
      revised := saved.record;
      foreach role_name in array array['orchestrator', 'coder', 'operator'] loop
        if revised #>> array[role_name, 'harness', 'harness'] = 'opencode' then
          revised := jsonb_set(revised, array[role_name],
            jsonb_set((revised->role_name) - 'harnessProfileSelection', '{harness}', replacement));
        end if;
      end loop;
      if revised = saved.record then return; end if;

      insert into application_setting_versions (id, setting_key, version, record)
      values (coalesce(saved.current_version_id, 'agent-defaults-v1-retired-v' || saved.revision),
        saved.key, saved.revision, saved.record)
      on conflict (setting_key, version) do nothing;

      version_id := 'agent-defaults-v1-v' || (saved.revision + 1) || '-harness-retirement';
      insert into application_setting_versions (id, setting_key, version, record)
      values (version_id, saved.key, saved.revision + 1, revised);
      update application_settings set record = revised, revision = saved.revision + 1,
        current_version_id = version_id, updated_at = now() where key = saved.key;
      insert into management_audit (principal_id, source, action, target_key, outcome, details)
      values (null, 'system', 'harness.defaults.retire', saved.key, 'allowed',
        jsonb_build_object('previousRevision', saved.revision, 'revision', saved.revision + 1));
    end; $retire_defaults$;

    update file_tool_sessions
    set revoked_at = coalesce(revoked_at, now())
    where record->>'transport' = 'opencode';
  `,
} as const
