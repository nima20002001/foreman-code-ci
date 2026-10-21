/** Native writer generations begin at zero; delivery fences remain strictly positive. */
export const remoteControlGenerationMigration = { version: 2026100602, sql: `
alter table interaction_delivery_attempts drop constraint if exists remote_owner_control_snapshot;
alter table interaction_delivery_attempts add constraint remote_owner_control_snapshot check (
  (remote_owner_control is null and remote_owner_control_token is null and remote_owner_control_fence is null and remote_owner_control_generation is null)
  or (jsonb_typeof(remote_owner_control)='object' and remote_owner_control->>'schemaVersion'='1'
    and remote_owner_control#>>'{action,kind}'='respond' and remote_owner_control#>>'{action,interactionId}'=interaction_id
    and remote_owner_control#>>'{native,sessionId}'=native_session_id and remote_owner_control#>>'{action,nativeInteractionId}'=native_request_id
    and length(remote_owner_control_token)>0 and remote_owner_control_fence>0 and remote_owner_control_generation>=0) is true);
` } as const
