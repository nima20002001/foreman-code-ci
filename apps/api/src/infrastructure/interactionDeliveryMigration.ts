/** HAP-05 / Agent 2: native delivery ownership and the durable graph-resume handoff. */
export const interactionDeliveryMigration = {
  version: 508,
  sql: `
    alter table interaction_delivery_attempts add column if not exists lease_owner text;
    alter table interaction_delivery_attempts add column if not exists lease_expires_at timestamptz;
    alter table interaction_delivery_attempts add column if not exists evidence jsonb;

    -- Migration 503 owns the shared intent and its exact graph identities.
    -- Extend that record rather than creating a second resume state machine.
    alter table interaction_graph_resumes
      add column if not exists attempt integer not null default 0 check (attempt >= 0),
      add column if not exists last_error text,
      add column if not exists completed_at timestamptz;
    create index if not exists interaction_graph_resumes_pending_idx
      on interaction_graph_resumes (lease_expires_at, interaction_id) where state='pending';

    -- An old delivered row is not proof that its graph handoff completed.
    insert into interaction_graph_resumes
      (interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision,state)
      select id,run_id,execution_id,record->>'graphThreadId',record->>'graphInterruptId',revision,'pending'
      from durable_interactions where record->>'deliveryState'='delivered'
      on conflict (interaction_id) do nothing;
  `,
} as const
