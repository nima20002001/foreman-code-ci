import { ManagementActionSchema } from '@foreman-code/contracts/management'

const supportedActions = JSON.stringify(ManagementActionSchema.options).replaceAll("'", "''")

export const retiredManagementActionsMigration = {
  version: 2026101703,
  sql: `
    create function pg_temp.remove_retired_management_actions(stored_grants jsonb)
    returns jsonb language sql immutable as $$
      select coalesce(jsonb_agg(jsonb_set(grant_record, '{actions}', actions) order by grant_order), '[]'::jsonb)
      from (
        select grant_record, grant_order, (
          select coalesce(jsonb_agg(action order by action_order), '[]'::jsonb)
          from jsonb_array_elements(grant_record->'actions') with ordinality a(action, action_order)
          where '${supportedActions}'::jsonb @> jsonb_build_array(action)
        ) as actions
        from jsonb_array_elements(stored_grants) with ordinality g(grant_record, grant_order)
      ) grants_with_supported_actions
      where jsonb_array_length(actions) > 0;
    $$;

    update management_principals
      set grants = pg_temp.remove_retired_management_actions(grants)
      where grants is distinct from pg_temp.remove_retired_management_actions(grants);
    update run_authority_principals
      set grant_ceiling = pg_temp.remove_retired_management_actions(grant_ceiling)
      where grant_ceiling is distinct from pg_temp.remove_retired_management_actions(grant_ceiling);
    update workflow_schedule_authorities
      set grant_ceiling = pg_temp.remove_retired_management_actions(grant_ceiling)
      where grant_ceiling is distinct from pg_temp.remove_retired_management_actions(grant_ceiling);

    drop function pg_temp.remove_retired_management_actions(jsonb);
  `,
} as const
