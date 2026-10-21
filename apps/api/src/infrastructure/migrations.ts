import { memoryRepeatDecisionMigration } from './memoryRepeatDecisionMigration.js'
import { memoryWaitingForUserMigration } from './memoryWaitingForUserMigration.js'
import { browserProfilesMigration } from './browserProfilesMigration.js'
import { conversationCredentialsMigration } from './conversationCredentialsMigration.js'
import { hierarchyAdmissionMigration } from './hierarchyAdmissionMigration.js'
import { hierarchyFeedbackMigration } from './hierarchyFeedbackMigration.js'
import { workflowChatIndexMigration } from './workflowChatIndexMigration.js'
import { workflowChatNotificationsMigration } from './workflowChatNotificationsMigration.js'
import { hierarchyControlSettlementMigration } from './hierarchyControlSettlementMigration.js'
import { workflowChatMigration } from './workflowChatMigration.js'
import { operatorSummaryActivityMigration } from './operatorSummaryActivityMigration.js'
import { workflowControlsMigration } from './workflowControlsMigration.js'
import { ciIntegrationSelectionMigration } from './ciIntegrationSelectionMigration.js'
import { ciExecutorCleanupMigration } from './ciExecutorCleanupMigration.js'
import { ciRetainedExecutorsMigration } from './ciRetainedExecutorsMigration.js'
import { computerNamesMigration } from './computerNamesMigration.js'
import { ciFailureHistoryMigration } from './ciFailureHistoryMigration.js'
import { ciGateSpeedIndexMigration } from './ciGateSpeedIndexMigration.js'
import { commandReceiptRetentionMigration } from './commandReceiptRetentionMigration.js'
import { activityHistoryIndexesMigration } from './activityHistoryIndexesMigration.js'
import { artifactTransferLookupMigration } from './artifactTransferLookupMigration.js'
import { jobInputTransferLookupMigration } from './jobInputTransferLookupMigration.js'
import { deviceManagedMcpMigration } from './deviceManagedMcpMigration.js'
import { workflowAuthoringMigration } from './workflowAuthoringMigration.js'
import { ciGrantMigration } from './ciGrantMigration.js'
import { runWorktreesMigration } from './runWorktreesMigration.js'
import { executionWorktreesMigration } from './executionWorktreesMigration.js'
import { workflowFileContextSessionMigration } from './workflowFileContextSessionMigration.js'
import { nativeBatchReadMigration } from './nativeBatchReadMigration.js'
import { withTransaction } from './transaction.js'
import { checkpointOwnerMigration } from './checkpointOwnerMigration.js'
import { errorMessage } from '../shared/errorMessage.js'
import { providerAccountsMigration, providerAccountObservationsMigration } from '../modules/provider-accounts/migration.js'
import { nativeProofSourceLimitMigration } from './nativeProofSourceLimitMigration.js'
import { nativeActivityNoiseMigration } from './nativeActivityNoiseMigration.js'
import { workspaceRepositoryImportsMigration } from './workspaceRepositoryImportsMigration.js'
import { retiredHarnessCredentialsMigration } from './retiredHarnessCredentialsMigration.js'
import { bugReportsMigration } from './bugReportsMigration.js'
import { bugReportLifecycleMigration } from './bugReportLifecycleMigration.js'
import { hostCiRunsMigration } from './hostCiRunsMigration.js'
import { ciHostSlotsMigration } from './ciHostSlotsMigration.js'
import { hostCiActivityMigration } from './hostCiActivityMigration.js'
import { ciActivityRunLockMigration } from './ciActivityRunLockMigration.js'
import { ciDispatchClaimsMigration } from './ciDispatchClaimsMigration.js'
import { agentIntervalMigration } from './agentIntervalMigration.js'
import { ciTestResultsMigration } from './ciTestResultsMigration.js'
import { ciLogTailMigration } from './ciLogTailMigration.js'
import { workResultRepairMigration } from './workResultRepairMigration.js'
import { databaseHotQueriesMigration } from './databaseHotQueriesMigration.js'
import { workflowOrderMigration } from './workflowOrderMigration.js'
import { ciFileDurationsMigration } from './ciFileDurationsMigration.js'
import { ciResultCacheMigration } from './ciResultCacheMigration.js'
import { ciTicketChangesMigration } from './ciTicketChangesMigration.js'
import { ciGroupWaitMigration } from './ciGroupWaitMigration.js'
import { ciRecoveryIndexesMigration } from './ciRecoveryIndexesMigration.js'
import { ciRequestSharingMigration } from './ciRequestSharingMigration.js'
import { ciDirectoryRetentionMigration } from './ciDirectoryRetentionMigration.js'
import { ciExecutionHistoryMigration } from './ciExecutionHistoryMigration.js'
import { ciSharedActivityMigration } from './ciSharedActivityMigration.js'
import { ciActivityRequesterLookupMigration } from './ciActivityRequesterLookupMigration.js'
import { ciRequesterHistoryMigration } from './ciRequesterHistoryMigration.js'
import { stateDeadlinesMigration } from './stateDeadlinesMigration.js'
import { sessionControlsMigration } from './sessionControlsMigration.js'
import { workerConversationBindingMigration } from './workerConversationBindingMigration.js'
import { workDeliverySettlementMigration } from './workDeliverySettlementMigration.js'
import { workDirectionResponseMigration } from './workDirectionResponseMigration.js'
import { localWorkflowNativeOutputMigration } from './localWorkflowNativeOutputMigration.js'
import { workExhaustedRouteMigration } from './workExhaustedRouteMigration.js'
import { workJoinRoundMigration } from './workJoinRoundMigration.js'
import { workUnresolvedRoutesMigration } from './workUnresolvedRoutesMigration.js'
import { workJoinDispatchMigration } from './workJoinDispatchMigration.js'
import { workJoinDispositionMigration } from './workJoinDispositionMigration.js'
import { workParentRequestMigration } from './workParentRequestMigration.js'
import { workReturnGroupMigration } from './workReturnGroupMigration.js'
import { memoryWorkIndexesMigration } from './memoryWorkIndexesMigration.js'
import { memoryBoardsMigration } from './memoryBoardsMigration.js'
import { workReturnNodeGroupingMigration } from './workReturnNodeGroupingMigration.js'
import { workflowHierarchyMigration } from './workflowHierarchyMigration.js'
import { hierarchyGroupsMigration } from './hierarchyGroupsMigration.js'
import { hierarchyDirectionMigration } from './hierarchyDirectionMigration.js'
import { coordinationResultMigration } from './coordinationResultMigration.js'
import { workReturnRequestMigration } from './workReturnRequestMigration.js'
import { compactCommandActivityMigration } from './compactCommandActivityMigration.js'
import { workflowPresentationMigration } from './workflowPresentationMigration.js'
import { operatorTerminalMigration } from './operatorTerminalMigration.js'
import { operatorTerminalHistoryMigration } from './operatorTerminalHistoryMigration.js'
import { operatorTurnRetirementMigration } from './operatorTurnRetirementMigration.js'
import { claudeCallbackMigration } from './claudeCallbackMigration.js'
import { nativeCorrelationProvidersMigration } from './nativeCorrelationProvidersMigration.js'
import { runSubagentsMigration } from './runSubagentsMigration.js'
import { deviceIdentityMigration } from '../modules/devices/migration.js'
import { activitySnapshotMigration } from './activitySnapshotMigration.js'
import { activitySourcesMigration } from './activitySourcesMigration.js'
import { activityCommandSourcesMigration } from './activityCommandSourcesMigration.js'
import { harnessInstanceSettingsMigration } from '../modules/harnesses/instanceSettings/migration.js'
import { harnessInstanceProfileEvidenceMigration } from '../modules/harnesses/instanceSettings/profileMigration.js'
import { computerSyncMigration } from './computerSyncMigration.js'
import { computerSyncIdentityMigration } from './computerSyncIdentityMigration.js'
import { buildComputersMigration } from './buildComputersMigration.js'
import { ciRuntimePreparationMigration } from './ciRuntimePreparationMigration.js'
import { ciRuntimeMainComputerMigration } from './ciRuntimeMainComputerMigration.js'
import { ciEnrollmentMigration } from './ciEnrollmentMigration.js'
import { workflowFailureCauseMigration } from './workflowFailureCauseMigration.js'
import { workflowJobAttemptIdentityMigration } from './workflowJobAttemptIdentityMigration.js'
import { workflowExecutionFailureMigration } from './workflowExecutionFailureMigration.js'
import { jobAdmissionQueueMigration } from './jobAdmissionQueueMigration.js'
import { jobQueueCleanupMigration } from './jobQueueCleanupMigration.js'
import { jobSourceCapacityWaitMigration } from './jobSourceCapacityWaitMigration.js'
import { jobQueueCompletionMigration } from './jobQueueCompletionMigration.js'
import { agentCiActivityMigration } from './agentCiActivityMigration.js'
import { runActivityCommitOrderMigration } from './runActivityCommitOrderMigration.js'
import { runActivityCommitLockMigration } from './runActivityCommitLockMigration.js'
import { jobSelectionTimeMigration } from './jobSelectionTimeMigration.js'
import { jobsMigration } from './jobsMigration.js'
import { currentMultiNodeAgentMigration } from './currentMultiNodeAgentMigration.js'
import { workflowJobsMigration } from './workflowJobsMigration.js'
import { jobRuntimeProfilesMigration } from './jobRuntimeProfilesMigration.js'
import { jobRuntimeNativeAdmissionMigration } from './jobRuntimeNativeAdmissionMigration.js'
import { remoteNativeArtifactOutputMigration } from './remoteNativeArtifactOutputMigration.js'
import { remoteNativeArtifactContextMigration } from './remoteNativeArtifactContextMigration.js'
import { remoteOwnerControlAdmissionMigration } from './remoteOwnerControlAdmissionMigration.js'
import { sourceCleanupLeaseMigration } from './sourceCleanupLeaseMigration.js'
import { jobRuntimeCaptureWithoutApprovalMigration } from './jobRuntimeCaptureWithoutApprovalMigration.js'
import { buildComputerRoleMigration } from './buildComputerRoleMigration.js'
import { buildComputerPriorityMigration } from './buildComputerPriorityMigration.js'
import { hostHarnessMeasurementsMigration } from './hostHarnessMeasurementsMigration.js'
import { remoteControlGenerationMigration } from './remoteControlGenerationMigration.js'
import { jobPreparationDeadlineMigration } from './jobPreparationDeadlineMigration.js'
import { jobRunCleanupMigration } from './jobRunCleanupMigration.js'
import { jobAcceptedIdentityMigration } from './jobAcceptedIdentityMigration.js'
import { jobActivityRevisionMigration } from './jobActivityRevisionMigration.js'
import { nodePlacementMigration } from './nodePlacementMigration.js'
import { remoteExecutionMigration } from './remoteExecutionMigration.js'
import { remoteDispatchOriginsMigration } from './remoteDispatchOriginsMigration.js'
import { artifactEdgeMigration } from './artifactEdgeMigration.js'
import { jobArtifactStorageMigration } from './jobArtifactStorageMigration.js'
import { jobArtifactXmlMigration } from './jobArtifactXmlMigration.js'
import { jobOutputAdmissionMigration } from './jobOutputAdmissionMigration.js'
import { jobInputAdmissionMigration } from './jobInputAdmissionMigration.js'
import { agentPlacementProducerMigration } from './agentPlacementProducerMigration.js'
import { sourceMetadataMigration } from '../modules/sources/migration.js'
import { sourceSnapshotUsesMigration } from './sourceSnapshotUsesMigration.js'
import { workspaceRootPoliciesMigration } from '../modules/sources/rootPoliciesMigration.js'
import { sourcePreparationReconciliationMigration } from './sourcePreparationReconciliationMigration.js'
import { workflowTerminalRecoveryMigration } from './workflowTerminalRecoveryMigration.js'
import { workflowRestartRecoveryMigration } from './workflowRestartRecoveryMigration.js'
import { workflowFailedAttemptRecoveryMigration } from './workflowFailedAttemptRecoveryMigration.js'
import { runInspectionMigration } from './runInspectionMigration.js'
import { currentApprovalAckMigration } from './currentApprovalAckMigration.js'
import { reviewCleanupEntryReceiptMigration, workflowNativeLifecycleMigration } from './workflowNativeLifecycleMigration.js'
import { installationIdentityMigration } from './runtimeIdentity.js'
import type pg from 'pg'
import { currentWorkflowWriterMigration } from './currentWorkflowWriterMigration.js'
import { currentStagedAgentsMigration } from './currentStagedAgentsMigration.js'
import { repeatWriterMigration } from './repeatWriterMigration.js'
import { repeatOccurrenceMigration } from './repeatOccurrenceMigration.js'
import { workflowClosureMigration } from './workflowClosureMigration.js'
import { graphEditIntentMigration } from './graphEditIntentMigration.js'
import { harnessSettingsMigration } from './harnessSettingsMigration.js'
import { pr18RecoveryMigration } from './pr18RecoveryMigration.js'
import { runLiveActivityMigration } from './runLiveActivityMigration.js'
import { reviewFailureLifecycleMigration } from './reviewFailureLifecycleMigration.js'
import { localHumanMigration } from './localHumanMigration.js'
import { retiredManagementActionsMigration } from './retiredManagementActionsMigration.js'
import { skillsLibraryMigration } from './skillsLibraryMigration.js'
import { currentApprovalPublicationMigration } from './currentApprovalPublicationMigration.js'
import { agentChatMigration } from './agentChatMigration.js'

import { lifecycleMigration } from './lifecycleMigration.js'
import { pr17AuditMigration } from './pr17AuditMigration.js'
import { nativeEventSequenceMigration } from './nativeEventSequenceMigration.js'

import { interactionDeliveryMigration } from './interactionDeliveryMigration.js'
import { operatorMcpMigration } from './operatorMcpMigration.js'
import { unifiedMcpMigration } from './unifiedMcpMigration.js'
import { operatorApprovalRemovalMigration } from './operatorApprovalRemovalMigration.js'
import { wave25RunGraphMigration } from './wave25RunGraphMigration.js'
import { wave25ReliabilityMigration } from './wave25ReliabilityMigration.js'
import { wave25ApprovalMigrationSql } from '../modules/interactions/wave25/migration.js'
import { nativeProjectionMigration } from '../modules/run-graph/nativeProjectionMigration.js'
import { workHandoffMigration } from './workHandoffMigration.js'
import { workNoticeMigration } from './workNoticeMigration.js'
import { runActivitiesMigration } from './runActivitiesMigration.js'
import { workflowScheduleDispatchMigration } from '../modules/schedules/dispatchMigration.js'
import { workflowScheduleMigration } from './workflowScheduleMigration.js'
import { runSnapshotMigration } from './runSnapshotMigration.js'
import { runPresentationMigration } from './runPresentationMigration.js'
import { fileStorageMigration } from './fileStorageMigration.js'
import { fileReferenceMigration } from './fileReferenceMigration.js'
import { fileRetentionMigration } from './fileRetentionMigration.js'
import { fileReferenceAccessMigration } from './fileReferenceAccessMigration.js'
import { fileToolsMigration } from '../modules/files/tools/migration.js'
import { harnessQualificationMigration } from './harnessQualificationMigration.js'
import { workspaceProvisioningMigration } from './workspaceProvisioningMigration.js'
import { workflowCollaborationMigration } from './workflowCollaborationMigration.js'

export const migrations = [
  { version: 1, sql: `
    create table if not exists application_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );

    create table if not exists workspaces (
      id text primary key,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists agents (
      id text primary key,
      workspace_id text not null references workspaces(id),
      current_configuration_version_id text,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists agent_configuration_versions (
      id text primary key,
      workspace_id text not null references workspaces(id),
      agent_id text not null references agents(id),
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (agent_id, version)
    );

    create table if not exists workflows (
      id text primary key,
      workspace_id text not null references workspaces(id),
      current_version_id text,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists workflow_versions (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      version integer not null,
      entry_node_id text not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (workflow_id, version)
    );

    create table if not exists runs (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      workflow_version_id text not null references workflow_versions(id),
      execution_state text not null,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists harness_executions (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      workflow_node_id text not null,
      agent_id text not null references agents(id),
      attempt integer not null,
      accepted boolean not null default false,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (run_id, workflow_node_id, attempt)
    );

    create table if not exists harness_native_events (
      execution_id text not null references harness_executions(id) on delete cascade,
      sequence integer not null,
      record jsonb not null,
      primary key (execution_id, sequence)
    );

    create table if not exists run_activity (
      run_id text not null references runs(id) on delete cascade,
      sequence bigint generated always as identity,
      source text not null,
      kind text not null,
      harness_execution_id text,
      occurred_at timestamptz not null,
      payload jsonb not null,
      primary key (run_id, sequence)
    );

    create index if not exists runs_workspace_workflow_idx
      on runs (workspace_id, workflow_id, created_at desc);
    create index if not exists harness_executions_run_idx
      on harness_executions (run_id, created_at);
    create index if not exists run_activity_run_idx
      on run_activity (run_id, sequence);
  ` },
  { version: 2, sql: `
    create table if not exists application_settings (
      key text primary key,
      record jsonb not null,
      updated_at timestamptz not null default now()
    );
  ` },
  { version: 3, sql: `
    alter table workspaces add column if not exists revision bigint not null default 1;
    alter table workspaces add column if not exists archived_at timestamptz;
    alter table workflows add column if not exists revision bigint not null default 1;
    alter table workflows add column if not exists archived_at timestamptz;
    alter table agents add column if not exists metadata_revision bigint not null default 1;
    alter table application_settings add column if not exists revision bigint not null default 1;

    create table if not exists management_principals (
      id text primary key,
      name text not null,
      audience text not null,
      token_hash text not null unique,
      grants jsonb not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      check (audience in ('operator', 'worker'))
    );

    create table if not exists management_command_receipts (
      principal_id text not null references management_principals(id),
      operation text not null,
      command_id text not null,
      target_key text not null,
      input_hash text not null,
      result jsonb not null,
      created_at timestamptz not null default now(),
      primary key (principal_id, operation, command_id)
    );

    create table if not exists management_audit (
      sequence bigint generated always as identity primary key,
      principal_id text,
      source text not null,
      action text not null,
      target_key text not null,
      outcome text not null,
      details jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now()
    );
    create index if not exists management_audit_principal_idx
      on management_audit (principal_id, sequence desc);

    create table if not exists graph_drafts (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      revision bigint not null,
      base_workflow_version_id text,
      record jsonb not null,
      discarded_at timestamptz,
      updated_at timestamptz not null default now(),
      unique (workflow_id)
    );
  ` },
  { version: 4, sql: `
    alter table workspaces add column if not exists execution_location jsonb;
    alter table workspaces add column if not exists execution_location_identity jsonb;
    alter table workspaces add column if not exists location_revision bigint not null default 0;

    alter table runs add column if not exists runner_id text;
    alter table runs add column if not exists working_directory text;
    alter table runs add column if not exists location_revision bigint;

    create index if not exists runs_workspace_location_idx
      on runs (workspace_id, location_revision) where location_revision is not null;
  ` },
  { version: 100, sql: `
    create table if not exists management_principals (
      id text primary key, name text not null, audience text not null,
      token_hash text not null unique, grants jsonb not null, expires_at timestamptz not null,
      revoked_at timestamptz, created_at timestamptz not null default now(),
      check (audience in ('operator', 'worker'))
    );
    create table if not exists application_settings (
      key text primary key, record jsonb not null, updated_at timestamptz not null default now(),
      revision bigint not null default 1
    );
    alter table management_principals add column if not exists agent_id text;
    create index if not exists management_worker_agent_idx
      on management_principals (agent_id) where audience = 'worker';

    create table if not exists application_setting_versions (
      id text primary key,
      setting_key text not null,
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (setting_key, version)
    );
    alter table application_settings add column if not exists current_version_id text;

    create table if not exists application_operators (
      id text primary key,
      current_configuration_version_id text not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists operator_configuration_versions (
      id text primary key,
      operator_id text not null references application_operators(id) deferrable initially deferred,
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (operator_id, version)
    );

    create table if not exists durable_interactions (
      id text primary key,
      workspace_id text not null,
      workflow_id text not null,
      run_id text not null,
      execution_id text not null,
      requesting_agent_id text not null,
      harness text not null,
      native_session_id text not null,
      native_request_id text not null,
      status text not null,
      revision bigint not null default 0,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (harness, native_session_id, native_request_id)
    );
    create index if not exists durable_interactions_scope_idx
      on durable_interactions (workspace_id, workflow_id, status, created_at, id);

    create table if not exists native_session_lanes (
      id text primary key,
      harness text not null,
      native_session_id text not null,
      owner_agent_id text not null,
      revision bigint not null default 0,
      record jsonb not null,
      updated_at timestamptz not null default now(),
      unique (harness, native_session_id)
    );
    create table if not exists review_jobs (
      id text primary key,
      interaction_id text not null references durable_interactions(id) on delete cascade,
      reviewer_agent_id text not null,
      state text not null,
      revision bigint not null default 0,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (interaction_id, reviewer_agent_id)
    );
  ` },
  { version: 400, sql: `
    create table if not exists worker_credential_bindings (
      principal_id text primary key,
      execution_id text not null,
      run_id text not null,
      workspace_id text not null,
      workflow_id text not null,
      agent_id text not null,
      environment_variable text not null,
      issued_at timestamptz not null default now(),
      revoked_at timestamptz,
      unique (execution_id, principal_id),
      check (environment_variable = 'GRAPHQL_APP_MCP_TOKEN')
    );
    create index if not exists worker_credential_bindings_execution_idx
      on worker_credential_bindings (execution_id, revoked_at);
  ` },
  { version: 401, sql: `
    alter table if exists runs add column if not exists worker_credentials_closed_at timestamptz;
    alter table if exists harness_executions add column if not exists worker_credentials_closed_at timestamptz;
    create index if not exists worker_credential_bindings_run_idx
      on worker_credential_bindings (run_id, principal_id);
    -- Preserve terminal cleanup intent across upgrades/restarts. The binding
    -- sweep revokes any remaining principals without needing the old plaintext.
    update runs set worker_credentials_closed_at=now()
      where execution_state not in ('queued','running','waiting') and worker_credentials_closed_at is null;
    do $$
    begin
      if to_regclass('harness_executions') is not null then
        update harness_executions set worker_credentials_closed_at=now()
          where record->>'state' not in ('starting','running','waiting') and worker_credentials_closed_at is null;
      end if;
    end
    $$;
  ` },
  { version: 500, sql: `
    create table if not exists approval_execution_state (
      execution_id text primary key,
      graph_thread_id text not null,
      active_timeout_ms bigint not null check (active_timeout_ms > 0),
      active_elapsed_ms bigint not null default 0 check (active_elapsed_ms >= 0),
      active_started_at timestamptz,
      approval_wait_started_at timestamptz,
      stopped_at timestamptz,
      revision bigint not null default 0,
      updated_at timestamptz not null default now()
    );

    create table if not exists interaction_delivery_attempts (
      interaction_id text not null references durable_interactions(id) on delete cascade,
      attempt integer not null check (attempt > 0),
      state text not null check (state in ('submitted','uncertain','delivered','failed')),
      native_session_id text not null,
      native_request_id text not null,
      correlation_id text not null,
      error text,
      created_at timestamptz not null default now(),
      primary key (interaction_id, attempt)
    );
    create index if not exists interaction_delivery_attempts_reconcile_idx
      on interaction_delivery_attempts (state, created_at, interaction_id);
  ` },
  { version: 501, sql: `
    create table if not exists interaction_command_receipts (
      principal_id text not null,
      command_id text not null,
      interaction_id text not null references durable_interactions(id) on delete cascade,
      option_id text not null,
      created_at timestamptz not null default now(),
      primary key (principal_id,command_id)
    );
  ` },
  { version: 502, sql: `
    alter table review_jobs add column if not exists execution_id text;
    alter table review_jobs add column if not exists working_directory text;
    alter table review_jobs add column if not exists provider_version text;
  ` },
  { version: 503, sql: `
    -- Additive HAP-05 recovery state. Native identities and applied SQL stay untouched.
    alter table durable_interactions
      add column delivery_owner text,
      add column delivery_token text,
      add column delivery_fence bigint not null default 0,
      add column delivery_lease_expires_at timestamptz,
      add column last_delivery_error jsonb,
      add column reconciliation_status text not null default 'not_required'
        check (reconciliation_status in ('not_required','required','delivered','not_delivered','unknown'));
    alter table interaction_delivery_attempts
      add column delivery_fence bigint not null default 0,
      add column evidence jsonb not null default '{}'::jsonb,
      add column updated_at timestamptz not null default now();
    alter table interaction_command_receipts
      add column decision_revision bigint,
      add column authorized_at timestamptz;
    -- Old receipts remain unverified until an authorized decision transaction binds them.

    create table interaction_reconciliation_evidence (
      sequence bigint generated always as identity primary key,
      interaction_id text not null references durable_interactions(id) on delete cascade,
      attempt integer,
      delivery_fence bigint not null,
      native_session_id text not null,
      native_request_id text not null,
      correlation_id text,
      outcome text not null check (outcome in ('delivered','not_delivered','unknown')),
      evidence jsonb not null,
      error jsonb,
      occurred_at timestamptz not null default now(),
      foreign key (interaction_id, attempt) references interaction_delivery_attempts(interaction_id, attempt)
    );

    create table interaction_graph_resumes (
      interaction_id text primary key references durable_interactions(id) on delete cascade,
      run_id text not null,
      execution_id text not null,
      graph_thread_id text not null,
      graph_interrupt_id text,
      delivery_revision bigint not null,
      state text not null default 'pending'
        check (state in ('pending','resuming','resumed','blocked','canceled')),
      revision bigint not null default 0,
      lease_owner text,
      lease_token text,
      lease_fence bigint not null default 0,
      lease_expires_at timestamptz,
      evidence jsonb not null default '{}'::jsonb,
      error jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    -- Backfill intent, not success: the graph owner must inspect the exact checkpoint
    -- before resuming a pre-migration delivery. This never replays native work.
    insert into interaction_graph_resumes
      (interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision,evidence)
      select id,run_id,execution_id,record->>'graphThreadId',record->>'graphInterruptId',revision,
        '{"requiresCheckpointReconciliation":true,"migration":503}'::jsonb
      from durable_interactions where status='delivered';

    alter table review_jobs
      add column lease_owner text,
      add column lease_token text,
      add column lease_expires_at timestamptz,
      add column lease_fence bigint not null default 0,
      add column recovery_evidence jsonb not null default '[]'::jsonb;
    update review_jobs set lease_owner=record->>'leaseOwner',lease_token=record->>'leaseToken',
      lease_expires_at=(record->>'leaseExpiresAt')::timestamptz,
      lease_fence=case when record->>'leaseToken' is null then 0 else 1 end;

    create index durable_interactions_execution_latest_idx
      on durable_interactions (execution_id,created_at desc,id desc);
    create index durable_interactions_delivery_recovery_idx
      on durable_interactions (delivery_lease_expires_at,id) where status='delivery_pending';
    create index interaction_reconciliation_history_idx
      on interaction_reconciliation_evidence (interaction_id,sequence);
    create index interaction_delivery_attempts_open_idx
      on interaction_delivery_attempts (interaction_id,attempt desc) where state in ('submitted','uncertain');
    create index interaction_graph_resumes_recovery_idx
      on interaction_graph_resumes (lease_expires_at,interaction_id) where state in ('pending','resuming','blocked');
    create index interaction_graph_resumes_run_idx on interaction_graph_resumes (run_id,state,interaction_id);
    create index review_jobs_recovery_idx
      on review_jobs (reviewer_agent_id,state,lease_expires_at,created_at,id);

    -- Typed lifecycle kinds are from ActivityKindSchema. Triggers keep the audit
    -- atomic even when another repository/worker performs the state transition.
    create function audit_interaction_lifecycle() returns trigger language plpgsql as $$
    declare previous jsonb; activity_payload jsonb; activity_kind text;
    begin
      previous := case when TG_OP='INSERT' then '{}'::jsonb else OLD.record end;
      activity_payload := jsonb_strip_nulls(jsonb_build_object(
        'interactionId',NEW.id,'revision',NEW.revision,'harness',NEW.harness,
        'nativeSessionId',NEW.native_session_id,'nativeRequestId',NEW.native_request_id,
        'handler',NEW.record->'approval'->>'handler','status',NEW.status,
        'previousStatus',previous->>'status','deliveryState',NEW.record->>'deliveryState',
        'previousDeliveryState',previous->>'deliveryState','deliveryFence',NEW.delivery_fence,
        'selectedOptionId',NEW.record->>'selectedOptionId','selectedSemantic',NEW.record->>'selectedSemantic',
        'auditReference',NEW.record->>'auditReference','error',NEW.last_delivery_error,
        'reconciliationStatus',NEW.reconciliation_status));
      foreach activity_kind in array array[
        case when TG_OP='INSERT' and NEW.status='pending' then 'interaction_pending' end,
        case when NEW.record->>'selectedOptionId' is not null and previous->>'selectedOptionId' is null
          then 'interaction_decided' end,
        case when TG_OP='UPDATE' and (NEW.record->>'deliveryState' is distinct from previous->>'deliveryState'
          or NEW.last_delivery_error is distinct from OLD.last_delivery_error
          or NEW.reconciliation_status is distinct from OLD.reconciliation_status) then 'interaction_delivery_state' end,
        case when NEW.status in ('delivered','delivery_failed','canceled')
          and NEW.status is distinct from previous->>'status' then 'interaction_resolved' end
      ] loop
        if activity_kind is not null then
          insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
            values (NEW.run_id,'backend',activity_kind,NEW.execution_id,clock_timestamp(),activity_payload);
        end if;
      end loop;
      if NEW.status='delivered' then
        insert into interaction_graph_resumes
          (interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision)
          values (NEW.id,NEW.run_id,NEW.execution_id,NEW.record->>'graphThreadId',
            NEW.record->>'graphInterruptId',NEW.revision) on conflict do nothing;
        update interaction_graph_resumes set graph_interrupt_id=NEW.record->>'graphInterruptId',
          revision=revision+1,updated_at=clock_timestamp()
          where interaction_id=NEW.id and graph_interrupt_id is null and NEW.record->>'graphInterruptId' is not null;
      elsif NEW.status='canceled' then
        update interaction_graph_resumes set state='canceled',revision=revision+1,lease_fence=lease_fence+1,
          lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp(),
          error=jsonb_build_object('code','INTERACTION_CANCELED','message','The interaction was canceled before graph resume completed.')
          where interaction_id=NEW.id and state not in ('resumed','canceled');
      end if;
      return NEW;
    end $$;
    create trigger durable_interaction_lifecycle after insert or update on durable_interactions
      for each row execute function audit_interaction_lifecycle();

    create function audit_interaction_delivery_attempt() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' or NEW.state is distinct from OLD.state or NEW.error is distinct from OLD.error
        or NEW.evidence is distinct from OLD.evidence then
        insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
          select i.run_id,'backend','interaction_delivery_state',i.execution_id,clock_timestamp(),
            jsonb_strip_nulls(jsonb_build_object('interactionId',NEW.interaction_id,'stage','attempt',
              'attempt',NEW.attempt,'deliveryState',NEW.state,'deliveryFence',NEW.delivery_fence,
              'nativeSessionId',NEW.native_session_id,'nativeRequestId',NEW.native_request_id,
              'correlationId',NEW.correlation_id,'error',NEW.error,'evidence',NEW.evidence))
            from durable_interactions i where i.id=NEW.interaction_id;
      end if;
      return NEW;
    end $$;
    create trigger interaction_delivery_attempt_lifecycle after insert or update on interaction_delivery_attempts
      for each row execute function audit_interaction_delivery_attempt();

    -- Typed columns mirror the existing ReviewJob contract; indexes never cast
    -- JSON timestamps, and recovery does not replace provider/session/correlation IDs.
    create function sync_review_job_lease() returns trigger language plpgsql as $$
    begin
      NEW.lease_owner := NEW.record->>'leaseOwner';
      NEW.lease_token := NEW.record->>'leaseToken';
      NEW.lease_expires_at := (NEW.record->>'leaseExpiresAt')::timestamptz;
      if TG_OP='INSERT' then
        NEW.lease_fence := case when NEW.lease_token is null then 0 else 1 end;
      else
        NEW.lease_fence := OLD.lease_fence + case
          when NEW.lease_token is not null and NEW.lease_token is distinct from OLD.lease_token then 1 else 0 end;
      end if;
      return NEW;
    end $$;
    create trigger review_job_lease before insert or update on review_jobs
      for each row execute function sync_review_job_lease();

    create function audit_review_job_lifecycle() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' or NEW.state is distinct from OLD.state or NEW.lease_fence is distinct from OLD.lease_fence
        or NEW.record->'error' is distinct from OLD.record->'error'
        or NEW.recovery_evidence is distinct from OLD.recovery_evidence then
        insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
          select i.run_id,'backend','review_job_state',NEW.execution_id,clock_timestamp(),
            jsonb_strip_nulls(jsonb_build_object('interactionId',NEW.interaction_id,'reviewJobId',NEW.id,
              'reviewerAgentId',NEW.reviewer_agent_id,'state',NEW.state,'revision',NEW.revision,
              'attempt',NEW.record->'attempt','harness',NEW.record->>'provider',
              'nativeSessionId',NEW.record->>'nativeSessionId','correlationId',NEW.record->>'correlationId',
              'providerTurnOrMessageId',NEW.record->>'providerTurnOrMessageId',
              'leaseFence',NEW.lease_fence,'error',NEW.record->'error','recoveryEvidence',NEW.recovery_evidence))
            from durable_interactions i where i.id=NEW.interaction_id;
      end if;
      return NEW;
    end $$;
    create trigger review_job_lifecycle after insert or update on review_jobs
      for each row execute function audit_review_job_lifecycle();
  ` },
  { version: 507, sql: `
    -- Some pre-foundation installations created management_principals without
    -- the default audience constraint name. Establish it before migration 509
    -- widens the unchanged historical constraint to include User principals.
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conrelid='management_principals'::regclass
          and conname='management_principals_audience_check'
      ) then
        alter table management_principals add constraint management_principals_audience_check
          check (audience in ('operator','worker'));
      end if;
    end
    $$;
  ` },
  interactionDeliveryMigration,
  lifecycleMigration,
  { version: 700, sql: `
    create table if not exists operator_conversations (
      id text primary key,
      operator_id text not null references application_operators(id),
      operator_configuration_version_id text not null references operator_configuration_versions(id),
      harness text not null,
      provider_version text,
      native_session_id text,
      active_request_id text,
      active_native_turn_id text,
      turn_state text not null default 'idle',
      last_error text,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (turn_state in ('idle','starting','active','canceling','uncertain','error'))
    );
    create unique index if not exists operator_conversations_native_session_idx
      on operator_conversations (harness, native_session_id) where native_session_id is not null;
    create index if not exists operator_conversations_recent_idx
      on operator_conversations (updated_at desc, id);
    create table if not exists operator_conversation_messages (
      id text primary key,
      conversation_id text not null references operator_conversations(id) on delete cascade,
      sequence bigint generated always as identity,
      role text not null,
      content text not null,
      client_request_id text,
      native_message_id text,
      record jsonb not null,
      created_at timestamptz not null default now(),
      check (role in ('user','assistant','system','tool')),
      unique (conversation_id, sequence)
    );
    create unique index if not exists operator_messages_request_idx
      on operator_conversation_messages (conversation_id, client_request_id) where client_request_id is not null;
    create unique index if not exists operator_messages_native_idx
      on operator_conversation_messages (conversation_id, native_message_id) where native_message_id is not null;
  ` },
  { version: 701, sql: `
    alter table operator_conversations add column if not exists owner_principal_id text references management_principals(id);
    alter table operator_conversations add column if not exists revision bigint not null default 0;
    alter table operator_conversations add column if not exists active_phase text;
    alter table operator_conversations add column if not exists cancel_requested boolean not null default false;
    alter table operator_conversations add column if not exists pending_interaction jsonb;
    alter table operator_conversations add column if not exists response_delivery text;
    alter table operator_conversations add column if not exists last_result jsonb;
    create table if not exists operator_conversation_turns (
      conversation_id text not null references operator_conversations(id) on delete cascade,
      request_id text not null,
      payload jsonb not null,
      input_hash text not null,
      retryable boolean not null default false,
      result jsonb,
      primary key (conversation_id,request_id)
    );
    -- Old receipts did not store route context. Preserve their content without guessing context.
    insert into operator_conversation_turns (conversation_id,request_id,payload,input_hash)
      select conversation_id,client_request_id,jsonb_build_object('content',content),'legacy'
      from operator_conversation_messages where client_request_id is not null
      on conflict do nothing;
    alter table management_principals add column if not exists delegated_from text references management_principals(id);
    create table if not exists operator_chat_credentials (
      principal_id text primary key references management_principals(id),
      conversation_id text not null references operator_conversations(id) on delete cascade
    );
    create index if not exists operator_chat_owner_idx on operator_conversations(owner_principal_id,updated_at desc,id);
    -- A restarted process cannot prove an old in-flight delivery did not happen.
    update operator_conversations set active_phase='submitting',turn_state='uncertain'
      where active_request_id is not null and active_phase is null;
  ` },
  operatorMcpMigration,
  pr17AuditMigration,
  nativeEventSequenceMigration,
  harnessSettingsMigration,
  { version: 170019, sql: `alter table operator_conversations add column if not exists deleted_at timestamptz;` },
  { version: 170020, sql: `
    create table operator_conversation_activity (
      sequence bigint generated always as identity primary key,
      conversation_id text not null,
      request_id text not null,
      activity_id text not null,
      revision bigint not null default 1,
      record jsonb not null,
      unique(conversation_id,request_id,activity_id),
      foreign key(conversation_id,request_id) references operator_conversation_turns(conversation_id,request_id) on delete cascade
    );
    create index operator_activity_conversation_sequence on operator_conversation_activity(conversation_id,sequence desc);
  ` },
  { version: 170021, sql: `
    alter table harness_mcp_change_plans add column managed_preset text
      check (managed_preset in ('operator', 'linear'));
  ` },
  pr18RecoveryMigration,
  { version: 170023, sql: `
    alter table operator_conversations
      add column parent_conversation_id text references operator_conversations(id),
      add column fork_request_id text,
      add column handoff_source_harness text,
      add column handoff_source_sequence bigint,
      add column handoff_omitted_messages integer not null default 0,
      add column handoff_context text;
    create unique index operator_conversations_fork_request_idx
      on operator_conversations(parent_conversation_id,fork_request_id)
      where parent_conversation_id is not null;
  ` },
  runLiveActivityMigration,
  reviewFailureLifecycleMigration,
  operatorApprovalRemovalMigration,
  wave25RunGraphMigration,
  wave25ReliabilityMigration,
  { version: 250003, sql: wave25ApprovalMigrationSql },
  nativeProjectionMigration,
  graphEditIntentMigration,
  workflowClosureMigration,
  repeatOccurrenceMigration,
  repeatWriterMigration,
  currentWorkflowWriterMigration,
  workflowNativeLifecycleMigration,
  currentApprovalAckMigration,
  currentStagedAgentsMigration,
  runInspectionMigration,
  workflowRestartRecoveryMigration,
  workflowTerminalRecoveryMigration,
  { version: 264402, sql: `
    create index workflows_workspace_id_page_idx on workflows (workspace_id, id);
  ` },
  installationIdentityMigration,
  { version: 264404, sql: `
    alter table harness_mcp_change_plans drop constraint harness_mcp_change_plans_managed_preset_check;
    alter table harness_mcp_change_plans add constraint harness_mcp_change_plans_managed_preset_check
      check (managed_preset in ('operator', 'worker', 'linear'));
  ` },
  { version: 264405, sql: `
    alter table workspaces add column created_project_folder jsonb;
    update workspaces w set created_project_folder = jsonb_build_object(
      'runnerId', w.execution_location->>'runnerId',
      'rootPath', w.execution_location->>'rootPath',
      'identity', w.execution_location_identity)
    where w.location_revision = 1 and w.execution_location_identity is not null
      and exists (select 1 from management_command_receipts r
        where r.operation = 'workspace.create' and r.result->'workspace'->>'id' = w.id
          and r.result->'executionLocation' = w.execution_location);
  ` },
  unifiedMcpMigration,
  skillsLibraryMigration,
  currentApprovalPublicationMigration,
  reviewCleanupEntryReceiptMigration,
  agentChatMigration,
  workHandoffMigration,
  workNoticeMigration,
  runActivitiesMigration,
  workflowScheduleMigration,
  runSnapshotMigration,
  workflowScheduleDispatchMigration,
  fileStorageMigration,
  fileReferenceMigration,
  fileRetentionMigration,
  fileToolsMigration,
  fileReferenceAccessMigration,
  harnessQualificationMigration,
  sourceMetadataMigration,
  workspaceRootPoliciesMigration,
  sourcePreparationReconciliationMigration,
  deviceIdentityMigration,
  activitySnapshotMigration,
  activitySourcesMigration,
  activityCommandSourcesMigration,
  harnessInstanceSettingsMigration,
  harnessInstanceProfileEvidenceMigration,
  jobsMigration,
  buildComputersMigration,
  currentMultiNodeAgentMigration,
  workflowJobsMigration,
  jobRuntimeProfilesMigration,
  jobPreparationDeadlineMigration,
  jobRunCleanupMigration,
  jobAcceptedIdentityMigration,
  jobActivityRevisionMigration,
  nodePlacementMigration,
  remoteExecutionMigration,
  remoteDispatchOriginsMigration,
  artifactEdgeMigration,
  jobArtifactStorageMigration,
  jobOutputAdmissionMigration,
  jobInputAdmissionMigration,
  agentPlacementProducerMigration,
  jobRuntimeNativeAdmissionMigration,
  remoteNativeArtifactOutputMigration,
  remoteOwnerControlAdmissionMigration,
  remoteNativeArtifactContextMigration,
  remoteControlGenerationMigration,
  hostHarnessMeasurementsMigration,
  sourceCleanupLeaseMigration,
  compactCommandActivityMigration,
  sessionControlsMigration,
  workerConversationBindingMigration,
  runSubagentsMigration,
  jobAdmissionQueueMigration,
  jobQueueCleanupMigration,
  runPresentationMigration,
  workflowPresentationMigration,
  workspaceProvisioningMigration,
  jobSelectionTimeMigration,
  workParentRequestMigration,
  workJoinRoundMigration,
  workExhaustedRouteMigration,
  workDeliverySettlementMigration,
  workDirectionResponseMigration,
  workUnresolvedRoutesMigration,
  workJoinDispatchMigration,
  workJoinDispositionMigration,
  operatorTerminalMigration,
  operatorTerminalHistoryMigration,
  operatorTurnRetirementMigration,
  localWorkflowNativeOutputMigration,
  localHumanMigration,
  claudeCallbackMigration,
  nativeCorrelationProvidersMigration,
  jobArtifactXmlMigration,
  jobRuntimeCaptureWithoutApprovalMigration,
  buildComputerRoleMigration,
  computerSyncMigration,
  computerSyncIdentityMigration,
  ciRuntimePreparationMigration,
  buildComputerPriorityMigration,
  retiredHarnessCredentialsMigration,
  jobQueueCompletionMigration,
  jobSourceCapacityWaitMigration,
  agentCiActivityMigration,
  ciRuntimeMainComputerMigration,
  ciEnrollmentMigration,
  workflowFailureCauseMigration,
  workflowJobAttemptIdentityMigration,
  workflowExecutionFailureMigration,
  workspaceRepositoryImportsMigration,
  bugReportsMigration,
  runActivityCommitOrderMigration,
  runWorktreesMigration,
  nativeProofSourceLimitMigration,
  nativeActivityNoiseMigration,
  hostCiRunsMigration,
  ciFileDurationsMigration,
  providerAccountsMigration,
  providerAccountObservationsMigration,
  hostCiActivityMigration,
  agentIntervalMigration,
  ciTestResultsMigration,
  ciLogTailMigration,
  workResultRepairMigration,
  databaseHotQueriesMigration,
  workflowOrderMigration,
  bugReportLifecycleMigration,
  ciHostSlotsMigration,
  checkpointOwnerMigration,
  ciResultCacheMigration,
  ciTicketChangesMigration,
  workflowAuthoringMigration,
  ciGrantMigration,
  deviceManagedMcpMigration,
  workflowFailedAttemptRecoveryMigration,
  artifactTransferLookupMigration,
  ciActivityRunLockMigration,
  ciDispatchClaimsMigration,
  ciGroupWaitMigration,
  ciRecoveryIndexesMigration,
  activityHistoryIndexesMigration,
  jobInputTransferLookupMigration,
  stateDeadlinesMigration,
  workReturnRequestMigration,
  ciRequestSharingMigration,
  ciRequesterHistoryMigration,
  ciSharedActivityMigration,
  ciDirectoryRetentionMigration,
  ciFailureHistoryMigration,
  commandReceiptRetentionMigration,
  ciExecutionHistoryMigration,
  ciGateSpeedIndexMigration,
  runActivityCommitLockMigration,
  sourceSnapshotUsesMigration,
  operatorSummaryActivityMigration,
  retiredManagementActionsMigration,
  computerNamesMigration,
  executionWorktreesMigration,
  workflowFileContextSessionMigration,
  nativeBatchReadMigration,
  ciIntegrationSelectionMigration,
  ciExecutorCleanupMigration,
  ciRetainedExecutorsMigration,
  workReturnGroupMigration,
  workReturnNodeGroupingMigration,
  ciActivityRequesterLookupMigration,
  { ...workflowHierarchyMigration, version: 2026102100 },
  hierarchyGroupsMigration,
  hierarchyDirectionMigration,
  workflowCollaborationMigration,
  coordinationResultMigration,
  workflowControlsMigration,
  hierarchyControlSettlementMigration,
  workflowChatIndexMigration,
  hierarchyFeedbackMigration,
  hierarchyAdmissionMigration,
  { ...workflowChatMigration, version: 2026102120 },
  conversationCredentialsMigration,
  { ...browserProfilesMigration, version: 2026102122 },
  { ...workflowChatNotificationsMigration, version: 2026102123 },
  { version: 2026102124, ...memoryBoardsMigration },
  { ...memoryWorkIndexesMigration, version: 2026102125 },
  memoryRepeatDecisionMigration,
  memoryWaitingForUserMigration,
] as const

export function assertMigrationVersions(entries: readonly { version: number }[]): void {
  const versions = new Set<number>()
  for (const { version } of entries) {
    if (versions.has(version)) throw new Error(`Duplicate application migration version: ${version}`)
    versions.add(version)
  }
}

export async function applyApplicationMigrations(pool: pg.Pool): Promise<void> {
  assertMigrationVersions(migrations)
  return withTransaction(pool, async (client) => {
    // One-time migrations can exceed the pool's request deadline.
    await client.query('set local statement_timeout = 0')
    const schema = (await client.query<{ schema: string | null }>('select current_schema() as schema')).rows[0]?.schema
    if (!schema) throw new Error('Application migrations require a current PostgreSQL schema.')
    // Independent test schemas can migrate together; retain the established
    // lock for the normal public schema and serialize callers of each schema.
    if (schema === 'public') await client.query('select pg_advisory_xact_lock($1)', [810_001])
    else await client.query('select pg_advisory_xact_lock($1, hashtext($2))', [810_001, schema])
    await client.query(`
      create table if not exists application_migrations (
        version integer primary key,
        applied_at timestamptz not null default now()
      )
    `)
    const applied = await client.query<{ version: number }>('select version from application_migrations')
    const appliedVersions = new Set(applied.rows.map((row) => row.version))
    for (const migration of migrations) {
      const { version } = migration
      if (appliedVersions.has(version)) continue
      try {
        await client.query(migration.sql)
      } catch (error) {
        const reason = errorMessage(error, 'Unknown database error')
        throw new Error(`Application migration ${version} failed: ${reason}. Resolve it before restarting.`, { cause: error })
      }
      await client.query('insert into application_migrations (version) values ($1)', [version])
    }
  })
}
