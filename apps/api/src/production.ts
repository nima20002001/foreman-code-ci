import { BROWSER_DEVICE_EXTENSION } from '@foreman-code/contracts'
import { createProductionBrowser } from './modules/collaboration/browserComposition.js'
import { createMainBrowserRemote } from './modules/collaboration/browserRemote.js'
import { prepareAgentChatInput, prepareOperatorChatInput } from './modules/collaboration/chatInputPreparation.js'
import { ConversationCredentials } from './modules/access/conversationCredentialIssuer.js'
import { conversationChatTools, readConversationCredential } from './modules/access/conversationCredentials.js'
import { ConversationNativeAccess } from './modules/collaboration/conversationNativeAccess.js'
import { createProductionWorkflowChat } from './modules/collaboration/groupChatProduction.js'
import { createMemoryBoardService } from './modules/memory-boards/production.js'
import { memoryBoardAuthority } from './modules/collaboration/memoryBoardAuthority.js'
import { requireRsyncTransferOwner } from './modules/byte-transfer/rsyncTransferOwner.js'
import { WorkflowCollaborationIntegration, type WorkflowFeaturePorts } from './modules/collaboration/workflowIntegration.js'
import { createWorkflowExecutionChatService } from './modules/collaboration/workflowChatProduction.js'
import { MANAGED_MCP_NAMESPACE } from '@foreman-code/contracts/managed-mcp-channel'
import { DeviceManagedMcp } from './modules/harnesses/deviceManagedMcp.js'
import { RunWorktrees } from './modules/runs/runWorktrees.js'
import { withTransaction } from './infrastructure/transaction.js'
import { withCiDatabaseReservation } from './infrastructure/ciDatabasePriority.js'
import { ComputerActivityService } from './modules/computers/activity.js'
import { registerComputerActivityRoutes } from './routes/computerActivity.js'
import { ComputerAccountsService } from './modules/computers/accounts.js'
import {
  AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE,
} from '@foreman-code/contracts/source-materialization'
import { agentFileReader } from './modules/ci-host/agentFileReader.js'
import { CiRuntimeProvisioner } from './modules/jobs/ciRuntimeProvisioner.js'
import { CiEnrollment } from './modules/jobs/ciEnrollment.js'
import { startStateDeadlineSweeper } from './modules/diagnostics/stateDeadlines.js'
import { reportServiceFailure, trackService } from './modules/diagnostics/serviceHealth.js'
import { ProductionCiEnrollmentInventory } from './modules/jobs/ciEnrollmentInventory.js'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE, DEFAULT_STUCK_EXECUTION_IDLE_MS } from '@foreman-code/contracts'
import { HostCiService } from './modules/ci-host/service.js'
import { GitCiCommits } from './modules/ci-host/commits.js'
import { RunCiAuthority } from './modules/jobs/ciAuthority.js'
import { ProductionHostCiEndpoint } from './modules/ci-host/endpoint.js'
import { HostCiRunner, systemHostCiPorts } from './modules/ci-host/runner.js'
import { CircleCreditUsage } from './modules/ci-host/circleCredits.js'
import { CircleAccountDirectory } from './modules/ci-host/circleAccounts.js'
import { CircleAccountsManagementService } from './modules/settings/circleAccounts.js'
import { CircleCreditCache } from './modules/ci-host/circleCreditCache.js'
import { circleOrganizations } from './modules/ci-host/circleOrganizations.js'
import { CircleStandby } from './modules/ci-host/circleStandby.js'
import { CircleAccountFleetStatus } from './modules/ci-host/circleAccountStatus.js'
import { registerCircleAccountRoutes } from './routes/circleAccounts.js'
import { homedir } from 'node:os'
import { activeCiRuns, circleCiOrgs, cloudCis, runningCircleCiOwners, workspaceMirrorList, workspaceMirrors }
  from './modules/ci-host/cloud.js'
import { configuredReservedCloudSlots } from './modules/ci-host/cloudSlots.js'
import { agentSnapshots, type ReadAgentFiles } from './modules/ci-host/agentSnapshots.js'
import { registerComputerAccountsRoutes } from './routes/computerAccounts.js'
import { registerComputerMaintenanceRoutes } from './routes/computerMaintenance.js'
import { FleetMaintenanceService } from './modules/computers/fleet.js'
import { computerConnectionsReader } from './modules/computers/connections.js'
import { startWorkerPublicationSync } from './modules/computers/workerPublicationSync.js'
import { createProductionWorkerArtifactExtension, readProductionWorkerManifestSha256s,
  readProductionWorkerContentSha256s, readProductionWorkerReleasePublication,
  workerArtifactLocation } from './modules/computers/workerArtifactsProduction.js'
import { ComputerMaintenance, claudeUserMcpServers, installedPlugins, pluginMarketplaces, systemMaintenancePorts } from './modules/computers/maintenance.js'
import { ComputerGitHubService } from './modules/computers/github.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_SYNC_NAMESPACE, COMPUTER_GITHUB_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { ComputerSyncService } from './modules/computers/sync.js'
import { registerComputerSyncRoutes } from './routes/computerSync.js'
import { sessionStartDirectory } from './modules/harnesses/sessionStart.js'
import { recoverPersistedClaudeCompaction } from './modules/harnesses/claudeSdk/recoverCompaction.js'
import { registerBuildComputerRoutes } from './routes/buildComputers.js'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appLauncherPath, appMcpServerName } from './modules/harnesses/appMcpLauncher.js'
import { createMainRsyncEntrypoint } from './modules/byte-transfer/installedEntrypoints.js'
import { PostgresTrustedConnectionSetup } from './modules/devices/trustedConnectionSetup.js'
import { registerTrustedConnectionRoutes } from './modules/devices/trustedConnectionManagement.js'
import { requirePrincipal } from './modules/access/http.js'
import { RsyncTransferAuthorizeRequestSchema } from '@foreman-code/contracts/byte-transfer'
import type { AcceptedTransferAuthority } from './modules/byte-transfer/carrier.js'
import type { InstalledMainRsyncProviders } from './modules/byte-transfer/productionComposition.js'
import { createInstalledRsyncComposition } from './modules/byte-transfer/productionComposition.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { transferContextForBinding } from './modules/byte-transfer/carrier.js'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@foreman-code/contracts/job-runtime'
import { interactionConnection } from './modules/interactions/connection.js'
import { createProductionRemoteWorkflow } from './modules/placement/productionRemoteWorkflow.js'
import { remoteMcpPreflight } from './modules/placement/remoteMcpPreflight.js'
import { closeCompletedWorkflowSources } from './modules/sources/workflowCleanup.js'
import { remoteWorkflowPreparationClosed } from './modules/sources/workflowPreparationCleanup.js'
import { readExecutionPlacement, readNativePlacement } from './modules/placement/persistence.js'
import { sourceNativeSessionContinues } from './modules/sources/workingDirectory.js'
import { placedContinuationValidator } from './modules/placement/continuation.js'
import { readLiveManagementPrincipal } from './modules/access/liveManagementPrincipal.js'
import { readSourceCurrentNativeSession } from './modules/sources/activeNativeSession.js'
import type { SourceActiveNativeSessionReader, SourceNativeSessionCaptureReader } from './modules/sources/executionHosts.js'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION, encodeWorkerMcpResult, decodeWorkerMcpRequest } from '@foreman-code/contracts/worker-mcp-relay'
import { AgentPlacementProducer } from './modules/placement/agentProducer.js'
import { RunPlacementReadService } from './modules/placement/readService.js'
import { NodePlacementChoicesService } from './modules/placement/choicesService.js'
import { ProductionPlacementChoiceDiscovery } from './modules/placement/choiceDiscovery.js'
import { readRemoteObservations } from './modules/runs/remote/persistence.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteExecutionStartupEnvironment } from './modules/settings/remoteExecutionConfig.js'
import { RemoteExecutionSettingsService } from './modules/settings/remoteExecution.js'
import { WorkerExecutionPolicy } from './modules/settings/workerExecution.js'
import { AgentExecutionPreparation } from './modules/placement/agentExecutionPreparation.js'
import { assertRemoteExecutionAuthority, createExecutionAuthorityExtension } from './modules/placement/executionAuthority.js'
import { MainWorkerMcpRelay, selectedMainMcpForward, createWorkerNativeOutputAuthorizationPort } from './modules/placement/workerMcpRelay.js'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { recoverWorkflowArtifactOutputs } from './modules/runs/remote/workflowArtifactRecovery.js'
import { readAcceptedPlacement } from './modules/placement/persistence.js'
import { repeatRuntimeDirectory, type RepeatRepositoryServices } from './modules/runs/repeatRepositoryHost.js'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import { BYTE_TRANSFER_NAMESPACE } from './modules/byte-transfer/carrier.js'
import { retainInstalledHarnessInventory } from './modules/harnesses/installedCodexInspection.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RESOURCE_TELEMETRY_CAPABILITY, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { createResourceTelemetryRuntime, type ResourceTelemetryRuntime } from './modules/resource-telemetry/runtime.js'
import { createPassiveTelemetryAuthorities } from './modules/resource-telemetry/productionAuthority.js'
import { createMainResourceTelemetryBindings } from './modules/resource-telemetry/ingestion/carrier.js'
import { registerResourceTelemetryRoutes } from './routes/resourceTelemetry.js'
import { registerResourceTelemetrySelectorRoutes } from './routes/resourceTelemetrySelector.js'
import { WorkspaceBoundLocationService } from './modules/workspace-roots/service.js'
import { ManagedWorkspaceRootService } from './modules/workspace-roots/managedRoot.js'
import { bootstrapLocalMainWorkspaceRoot } from './modules/workspace-roots/localMainBootstrap.js'
import { WorkspaceRepositoryService } from './modules/workspaces/repositoryService.js'
import { registerWorkspaceRepositoryRoutes } from './routes/workspaceRepository.js'
import { registerWorkspaceRootRoutes } from './modules/workspace-roots/transports.js'
import { RemoteJobMainRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { JOB_INPUT_NAMESPACE } from './modules/files/jobInputs/service.js'
import { PostgresWorkflowJobNodeStore, workflowJobStorePublication } from './modules/jobs/workflowStore.js'
import { createProductionJobs } from './modules/jobs/production.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { WorkflowHierarchyService } from './modules/workflow-hierarchy/service.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerJobRuntimeProfileRoutes } from './routes/jobRuntimeProfiles.js'
import { registerSourceRoutes } from './routes/sources.js'
import { createClaudeProductionDiscovery } from './modules/harnesses/claudeSdk/bootstrap.js'
import { productionClaudeMetadata } from './modules/harnesses/claudeSdk/productionMetadata.js'
import { initializeNativeDefaults } from './modules/harnesses/initializeDefaults.js'
import { qualifyClaudeNativeProfile } from './modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { installedClaudeProfilePin } from './modules/harnesses/claudeSdk/installedProfilePin.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './modules/harnesses/claudeSdk/profileRevision.js'
import { discoverInventoryLauncher } from './modules/harnesses/hostDiscovery.js'
import { inventoryDriverPayloads } from './modules/harnesses/payloadDiscovery.js'
import { runCommand } from './modules/harnesses/process.js'
import { productionClaudeManager, type ClaudeProfileOwner } from './modules/harnesses/claudeSdk/production.js'
import { requireClaudeProductionCredentialDelivery } from './modules/harnesses/claudeSdk/productionCredentials.js'
import { ProviderAccountsService } from './modules/provider-accounts/service.js'
import { ProviderAccountsRepository } from './modules/provider-accounts/repository.js'
import { LocalProviderCredentials } from './modules/provider-accounts/localCredentials.js'
import { createProductionAccountSelection } from './modules/provider-accounts/productionSelection.js'
import { ProviderAccountWorkerAuthorityRequestSchema } from '@foreman-code/contracts/provider-accounts'
import { createRemoteAccountServices } from './modules/provider-accounts/remoteServices.js'
import { NativeProviderAccountCommands, type AccountNativeSelection } from './modules/provider-accounts/nativeCommands.js'
import { NativeProviderAccountOperations } from './modules/provider-accounts/nativeOperations.js'
import { NativeAccountJournal } from './modules/provider-accounts/nativeJournal.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { ProviderAccountConfigurationService } from './modules/harnesses/providerAccountConfiguration.js'
import { prepareClaudeWorkflowCredentials } from './modules/harnesses/claudeSdk/workflowCredentials.js'
import { PostgresClaudeInteractionAuthority } from './modules/harnesses/claudeSdk/domainAuthority.js'
import { productionSelectedProfileManager } from './modules/harnesses/selectedProfileProduction.js'
import { createProductionWorkerConversations } from './modules/conversations/workerProduction.js'
import { REMOTE_PREPARATION_EXTENSION, WorkerConversationCallbackSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { credentialAuthority } from './modules/interactions/wave25/credentialAuthority.js'
import { readCoordinatorCredentialAuthority } from './modules/access/consultationAuthority.js'
import type { GraphSqlClient } from './modules/run-graph/connection.js'
import { currentOperatorAuthority } from './modules/access/runAuthority.js'
import { requireAuthorization } from './modules/access/policy.js'
import { AcceptedHarnessProfileAdmission, AcceptedClaudeProfileAdmission, type AcceptedProfileAuthority } from './modules/harnesses/instanceSettings/acceptedProfile.js'
import { workflowProfileSelection } from './modules/harnesses/workflowProfileSelection.js'
import { authorizeOperatorProfileObservation } from './modules/harnesses/operatorProfileObservation.js'
import {
  HarnessExecutionRequestSchema,
  OperatorConfigurationVersionSchema,
  RETIRED_OPENCODE_MESSAGE,
  type AgentDefaults,
} from '@foreman-code/contracts'
import { inspectClaudeOperatorConfiguration } from './modules/harnesses/claudeSdk/operatorConfigurationInspection.js'
import { inspectWorkerClaudeOperatorConfiguration } from './modules/harnesses/workerClaudeOperatorInspection.js'
import { requireClaudePolicyQualification } from './modules/harnesses/claudeSdk/configuration.js'
import { qualificationError } from './modules/harnesses/qualificationErrors.js'
import { authorizeOperatorConfigurationRead } from './modules/operators/configurationRead.js'
import { operatorCodexFileAdmissions } from './modules/harnesses/operatorFiles/codex.js'
import { nativeCorrelation } from './modules/conversations/operatorChatRepository.js'
import { randomUUID } from 'node:crypto'
import { createWorkflowNativeCaptureChannel } from './modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from './modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from './modules/interactions/reviewNativeProof.js'
import { readRetainedRemoteReviewer } from './modules/interactions/retainedRemoteReviewer.js'
import { PostgresRepeatReviewerBindings } from './modules/interactions/repeatReviewer.js'
import { createWorkflowRepositoryServices } from './modules/runs/workflowRepositoryServices.js'
import { createProductionWorkflowArtifactResultSource } from './modules/runs/remote/workflowArtifactResultProduction.js'
import { WorkflowArtifactResultAdoption } from './modules/runs/remote/workflowArtifactResultAdoption.js'
import { createWorkflowArtifactOutputsGate } from './modules/runs/remote/workflowArtifactAcceptance.js'
import { LocalWorkflowArtifactAuthority, workflowArtifactsAreLocal } from './modules/runs/remote/localWorkflowArtifactAuthority.js'
import { LocalWorkflowArtifacts } from './modules/runs/remote/localWorkflowArtifacts.js'
import { createLocalWorkflowNativeOutputs } from './modules/runs/remote/localWorkflowNativeOutputs.js'
import { readAcceptedRepeatRunLocked } from './modules/runs/repeatStartRead.js'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { qualifyCodex } from './modules/harnesses/codexProtocol.js'
import { PostgresWorkflowPhysicalArtifacts } from './modules/runs/remote/workflowPhysicalArtifacts.js'
import { readRuntimeIdentity, readRuntimeBuildIdentity } from './infrastructure/runtimeIdentity.js'
import { readTestResourcesIdentity } from './infrastructure/testRuntimeResources.js'
import { fileURLToPath } from 'node:url'
import { AppMcpRoutes } from './modules/harnesses/appMcpRoutes.js'
import { registerApprovalCheckpointResume } from './modules/runs/approvalCheckpointRegistration.js'
import { createCurrentNativeProductionFactory, isCurrentNativeProductionBinding } from './modules/runs/workflowProduction.js'
import { isDeepStrictEqual } from 'node:util'
import { NativeResponseJournal } from './modules/harnesses/recovery/responseJournal.js'
import { hasDetachedStdioProcess, hasNativeRestartDetachment, NativeProcessRegistry,
  type NativeProcessRecovery } from './modules/harnesses/recovery/processRegistry.js'
import { join, resolve } from 'node:path'

import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import { registerProductionFileStorage } from './modules/files/production.js'
import { createProductionWorkflowFileContexts } from './modules/runs/remote/workflowNativeFilesProduction.js'
import {
  PostgresArtifactPublicationAuthority,
  PostgresAcceptedArtifactAttemptFence,
  type NativeArtifactAuthorityPorts,
} from './modules/runs/remote/nativeArtifactAuthority.js'
import { mountProductionWorkflowArtifacts } from './modules/runs/remote/workflowArtifactProduction.js'
import { createMainWorkflowArtifactTransferExtension } from './modules/runs/remote/workflowArtifactTransferProduction.js'
import type { TemporaryFileService } from './modules/files/service.js'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { postgresCodexChatFiles } from './modules/harnesses/codexFiles/chatAdmission.js'
import { codexChatHostDirectory, localCodexChatHost } from './modules/harnesses/codexFiles/localHost.js'
import { productionFileTools } from './modules/files/tools/production.js'
import { FileRetentionService } from './modules/files/retention.js'
import { PostgresCommandReceiptRetention } from './modules/commands/receiptRetention.js'
import { registerFileRetentionRoutes } from './routes/fileRetention.js'
import { createOperatorExtensions } from './mcp/operator/extensions.js'
import { NativeConfigurationService } from './modules/harnesses/nativeConfiguration.js'
import { HarnessMcpSettingsService } from './modules/harnesses/mcpSettings.js'
import { ClaudePluginSettingsService } from './modules/harnesses/claudePlugins.js'
import { readClaudePlugins } from './modules/computers/claudePlugins.js'
import { CodexPluginSettingsService } from './modules/harnesses/codexPluginSettings.js'
import { NativeCodexPlugins } from './modules/harnesses/codexPlugins.js'
import { MainCodexSelection } from './modules/computers/installedCodexSelection.js'
import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { HarnessDirectoryBrowser } from './modules/harnesses/directoryBrowser.js'
import { CodexMcpConnections } from './modules/harnesses/codexMcpConnections.js'
import type { CheckpointStore } from './infrastructure/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { OperatorRuntimeOwner } from './infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from './infrastructure/runtimeShutdown.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { PostgresLocalHumanAccess } from './modules/access/localHuman.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from './modules/interactions/wave25/credentials.js'
import {
  ensureOperatorRuntimeDirectory,
  OperatorChatService,
  PostgresOperatorConversationRepository,
} from './modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from './modules/conversations/operatorChatAuthority.js'
import { AgentChatService, type AgentChatManagerFactory } from './modules/conversations/agentChat.js'
import { qualifiedAgentChatSteer } from './modules/conversations/chatSteerQualification.js'
import { PostgresAgentChatRepository } from './modules/conversations/agentChatRepository.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { BugReportService } from './modules/bug-reports/service.js'
import { DomainError } from './modules/errors.js'
import { productionSubagentControls } from './modules/subagents/productionControls.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { FileCompatibilityCache } from './modules/harnesses/compatibility/cache.js'
import { scopedCompatibilityProbe } from './modules/harnesses/compatibility/scopedProbe.js'
import { HarnessCompatibilityService } from './modules/harnesses/compatibility/service.js'
import { HarnessQualificationRepository } from './modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from './modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from './modules/harnesses/qualification/service.js'
import type { QualificationSuite } from './modules/harnesses/qualification/types.js'
import { withNativeQualificationOwnership } from './modules/harnesses/qualification/nativeOwnership.js'
import { qualificationIdentity, withQualificationIdentity } from './modules/harnesses/qualification/identity.js'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { NativeHarnessFactories } from './modules/harnesses/runtimeFactory.js'
import type { ProductionHarnessInfrastructure } from './modules/harnesses/productionInfrastructure.js'
import { productionCodexChatFiles, type ProductionCodexChatFiles } from './modules/harnesses/codexFiles/production.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { productionOperatorManagers } from './modules/harnesses/operatorFiles/managers.js'
import { ExecutionReadinessService } from './modules/harnesses/executionReadiness.js'
import { NativeRollout } from './modules/harnesses/nativeRollout.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { NativeHarnessConfigurationQualifier } from './modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { PostgresWorkflowClosureStore } from './modules/interactions/workflowClosure.js'
import { retryStartupDatabase } from './infrastructure/startupDatabase.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { Wave25InteractionRepository as PostgresInteractionRepository } from './modules/interactions/wave25/repository.js'
import { ExecutionScopedNativeSessionManagerResolver,
  type NativeManagerResolutionContext } from './modules/interactions/runtimePorts.js'
import { InteractionService } from './modules/interactions/service.js'
import { AutomaticReviewService } from './modules/interactions/automaticReview.js'
import { PostgresOperatorRepository } from './modules/operators/postgres.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { PostgresFoundationSettingsRepository } from './modules/settings/foundation.js'
import { FoundationSettingsManagementService } from './modules/settings/management.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { AgentManagementService } from './modules/workspaces/agents.js'
import { requiredLocationAccess, WorkspaceLocationService } from './modules/workspaces/location.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'
import { RunGraphReadService } from './modules/run-graph/readService.js'
import type { CurrentRunProductionFactory, CurrentRunProductionBinding, CurrentStopContext } from './modules/runs/currentProduction.js'
import type { FastifyBaseLogger } from 'fastify'
import { componentLogger } from './infrastructure/logger.js'
import { ProductionDeviceRuntime } from './modules/devices/productionRuntime.js'
import { ProductionHarnessRegistry } from './modules/harnesses/productionRegistry.js'
import { ProductionHostHarnessProfileQualifier } from './modules/harnesses/productionProfileQualifier.js'
import { HarnessInstanceSettingsRepository } from './modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from './modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from './modules/harnesses/instanceSettings/profileChecks.js'
import { HarnessInstallationMonitor } from './modules/harnesses/installationMonitor.js'
import { createInstalledNativeQualificationRetention } from './modules/harnesses/installedNativeQualificationRetention.js'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from './modules/harnesses/instanceSettings/service.js'
import { commandInputHash } from './modules/commands/postgres.js'
import { authorizeDeviceHost, assertDeviceHostInstallation } from './modules/devices/hostAuthorization.js'

/** The native owner supplies slot-specific installation and isolation qualification. */
export type ProductionProviderAccountSelection = AccountNativeSelection & {
  selectAccount?: NonNullable<ConstructorParameters<typeof NativeHarnessFactories>[0]['selectAccount']>
}

type ProductionMainInstallation = Awaited<ReturnType<ProductionDeviceRuntime['initializeFromRuntime']>>

interface ProductionComposition {
  collaborationPorts: WorkflowFeaturePorts | undefined
  workflowCollaboration: WorkflowCollaborationIntegration
  config: ApiConfig
  database: ReturnType<typeof createDatabase>
  checkpoints: CheckpointStore
  logger: boolean | FastifyBaseLogger
  createCurrentProduction: CurrentRunProductionFactory | undefined
  codexChatFiles: ProductionCodexChatFiles | undefined
  qualificationSuites: Record<CompatibilityHarness, QualificationSuite> | undefined
  infrastructure: ProductionHarnessInfrastructure | undefined
  accountSelection: ProductionProviderAccountSelection | undefined
  mainCodex: MainCodexSelection
  mainBinaries: { readonly codexBinary: string }
  workerExecution: WorkerExecutionPolicy
  fileStorage: TemporaryFileService | undefined
  fileStorageRoot: string
  chatFileAdmissions: ProductionCodexChatFiles
  responseJournal: NativeResponseJournal
  processRegistry: NonNullable<ProductionHarnessInfrastructure['auxiliary']>['recovery'] | NativeProcessRegistry
  access: PostgresAccessService
  agentPlacement: AgentPlacementProducer | undefined
  agentPreparation: AgentExecutionPreparation | undefined
  executionAuthority: ReturnType<typeof createExecutionAuthorityExtension> | undefined
  workflowArtifacts: ReturnType<typeof mountProductionWorkflowArtifacts> | undefined
  workflowPhysicalArtifacts: PostgresWorkflowPhysicalArtifacts | undefined
  artifactComposition: {
    mainId: string
    authority: PostgresArtifactPublicationAuthority
    fence: PostgresAcceptedArtifactAttemptFence
  } | undefined
  mainWorkerMcp: MainWorkerMcpRelay | undefined
  trustedConnections: PostgresTrustedConnectionSetup | undefined
  inputAcknowledgements: Map<string, TransferIntent>
  acceptedRsync: AcceptedTransferAuthority
  entrypoint: ReturnType<typeof createMainRsyncEntrypoint> | undefined
  installedRsync: InstalledMainRsyncProviders | undefined
  rsync: ReturnType<typeof createInstalledRsyncComposition>
  remoteTelemetry: ReturnType<typeof createMainResourceTelemetryBindings>
  deviceRuntime: ProductionDeviceRuntime
  commands: PostgresCommandCoordinator
  bugReports: BugReportService
  selectedAccounts: ProductionProviderAccountSelection
  providerAccounts: ProviderAccountsService
  workflowAccountBindings: Map<string, AcceptedProviderAccountBinding>
  accountConfigurations: ProviderAccountConfigurationService
  workflowCapture: ReturnType<typeof createWorkflowNativeCaptureChannel>
  reviewCapture: ReturnType<typeof createReviewNativeCaptureChannel>
  admitWorkflowFileContext: ReturnType<typeof createProductionWorkflowFileContexts> | undefined
  artifactResultSource: ReturnType<typeof createProductionWorkflowArtifactResultSource> | undefined
  artifactOutputsGate: ReturnType<typeof createWorkflowArtifactOutputsGate> | undefined
  localWorkflowArtifacts: LocalWorkflowArtifacts | undefined
  memoryBoards: ReturnType<typeof createMemoryBoardService>
  workflowRuntime: ReturnType<typeof createWorkflowRepositoryServices>
  repository: PostgresInteractionRepository
  budgets: PostgresApprovalBudgetRepository
  projectRoot: string
  runWorktrees: RunWorktrees
  locations: WorkspaceLocationService
  workflows: PostgresWorkflowRepository
  runs: PostgresRunRepository
  remoteWorkflow: ReturnType<typeof createProductionRemoteWorkflow>
  workspaces: PostgresWorkspaceRepository
  settings: PostgresSettingsRepository
  hostProfileEvidence: HostHarnessProfileEvidenceRepository
  claudeDiscovery: ReturnType<typeof createClaudeProductionDiscovery>
  harnessRegistry: ProductionHarnessRegistry
  foundationSettings: PostgresFoundationSettingsRepository
  remoteExecution: RemoteExecutionSettingsService
  operators: PostgresOperatorRepository
  rollout: NativeRollout
  compatibilityProbe: (
    timeoutMs?: number,
    expected?: { harness: CompatibilityHarness; binary: string },
  ) => ReturnType<typeof scopedCompatibilityProbe>
  qualificationRepository: HarnessQualificationRepository
  selectedSuites: Record<CompatibilityHarness, QualificationSuite> | undefined
  qualificationRegistry: HarnessQualificationRegistry | undefined
  harnessQualifications: HarnessQualificationService | undefined
  harnessCompatibility: HarnessCompatibilityService
  appMcpEndpoint: string
  nativeFactories: NativeHarnessFactories
  hostSettings: HarnessInstanceSettingsRepository
  hostAuthority: HostHarnessOverrideAuthority
  profileAuthority: AcceptedProfileAuthority<ClaudeProfileOwner>
  selectedProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  claudeProfiles: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  hostProfileChecks: HostHarnessInstanceProfileChecks
  harnessInstances: HostHarnessOverrideService
  installationMonitor: HarnessInstallationMonitor
  harnessCatalog: HarnessCatalogService
  nativeConfigurations: NativeConfigurationService
  appRoutes: AppMcpRoutes
  maintenancePorts: ReturnType<typeof systemMaintenancePorts>
  harnessSettings: {
    claudePlugins: ClaudePluginSettingsService
    directories: HarnessDirectoryBrowser
    plugins: CodexPluginSettingsService
    mcp: HarnessMcpSettingsService
  }
  launchScopes: WeakMap<NativeHarnessSessionManager, NativeProcessRecovery>
  claudeLaunches: WeakMap<NativeHarnessSessionManager, ReturnType<typeof productionClaudeManager>>
  managers: ExecutionScopedNativeSessionManagerResolver
  validateContinuation: ReturnType<typeof placedContinuationValidator>
  credentials: WorkerCredentialService
  prepareWorkflowManagerContext: (context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>
  launchCredentials: ExecutionCredentialProvider
  approvals: ApprovalExecutionCoordinator
  telemetry: ResourceTelemetryRuntime | undefined
  telemetryLifetime: AbortController
  mainTelemetryContext: Extract<TrustedTelemetryContext, { kind: 'main-local' }> | null
  jobRuntime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
  hostCi: HostCiService | undefined
  engine: LangGraphWorkflowEngine
  interactions: InteractionService
  operatorWorkingDirectory: string
  operatorManagers: Map<string, NativeHarnessSessionManager>
  operatorConversations: PostgresOperatorConversationRepository
  agentConversations: PostgresAgentChatRepository
  browser: ReturnType<typeof createProductionBrowser>
  browserRemote: ReturnType<typeof createMainBrowserRemote>
  conversationNativeAccess: ConversationNativeAccess
  workflowChat: ReturnType<typeof createProductionWorkflowChat>
  stopWorkflowChat?: () => void
  workerChats: ReturnType<typeof createProductionWorkerConversations>
  agentChatProfileSelection: (
    configuration: import('@foreman-code/contracts').AgentConfigurationVersion,
    workingDirectory: string,
    executionId?: string,
  ) => Promise<{
    profileSelection: import('@foreman-code/contracts').AgentConfigurationVersion['harnessProfileSelection']
    sourceExecution: import('@foreman-code/contracts/remote-execution-rpc').WorkerConversationBinding['sourceExecution'] | undefined
  }>
  recoverChatCompaction: (
    configuration: import('@foreman-code/contracts').OperatorConfigurationVersion
      | import('@foreman-code/contracts').AgentConfigurationVersion,
    conversationId: string,
    session: import('@foreman-code/contracts').NativeSessionReference,
    start: import('./modules/harnesses/port.js').NativeSessionStart,
    state: import('@foreman-code/contracts').CompactionState,
    principalId: string,
    signal: AbortSignal,
    profileSelection?: import('@foreman-code/contracts').AgentConfigurationVersion['harnessProfileSelection'],
    sourceExecution?: import('@foreman-code/contracts/remote-execution-rpc').WorkerConversationBinding['sourceExecution'],
  ) => Promise<import('@foreman-code/contracts').CompactionState>
  operatorAccountBindings: Map<string, AcceptedProviderAccountBinding>
  resolveOperatorManager: ReturnType<typeof productionOperatorManagers>
  chatAuthority: PostgresOperatorChatAuthority
  chat: OperatorChatService
  agentChat: AgentChatService
  reviews: AutomaticReviewService
  closing: boolean
  initialized: boolean
  operatorServices: OperatorServices & { fileRetention: FileRetentionService }
  runtimeServices: OperatorServices
  app: ReturnType<typeof buildApp>
  mountArtifacts: () => void
  httpClosing: boolean
  startupLifetime: AbortController
  schemaPreparation: Promise<void> | undefined
  initialization: Promise<void> | undefined
  nativeDefaultsInitialization: Promise<void> | undefined
  reconciliation: Promise<void> | undefined
  applicationClose: Promise<void> | undefined
  stopComputerTimers: () => void
  stopSyncTimer: () => void
  runtimeOwner: OperatorRuntimeOwner
  lifecycle: RuntimeShutdown
  beginShutdown: () => void
  assertOpen: () => void
  startupDatabase: <T>(work: () => Promise<T>) => Promise<T>
  synchronizeOperatorDefaults: (template: AgentDefaults['operator']) => Promise<void>
  prepareSchema: () => Promise<void>
  initialize: () => Promise<void>
  reconcile: (report: (error: unknown) => void) => Promise<void>
  drainShutdown: () => Promise<void>
  shutdown: () => Promise<void>
}

/** The startup composition is shared with regression tests; infrastructure owns its lifecycle. */
export function buildProductionApp(
  config: ApiConfig,
  database: ReturnType<typeof createDatabase>,
  checkpoints: CheckpointStore,
  // The shared API logger by default; tests pass false.
  logger: boolean | FastifyBaseLogger = componentLogger('http'),
  createCurrentProduction?: CurrentRunProductionFactory,
  // Trusted FIL-10 admission + execution-host ports; never populated from HTTP fields.
  codexChatFiles?: ProductionCodexChatFiles,
  qualificationSuites?: Record<CompatibilityHarness, QualificationSuite>,
  infrastructure?: ProductionHarnessInfrastructure,
  accountSelection?: ProductionProviderAccountSelection,
  collaborationPorts?: WorkflowFeaturePorts,
) {
  // Service callbacks read the same slots as later startup and shutdown stages.
  const composition = {
    config,
    database,
    checkpoints,
    logger,
    createCurrentProduction,
    codexChatFiles,
    qualificationSuites,
    infrastructure,
    accountSelection,
    collaborationPorts,
  } as ProductionComposition
  configureMainTransport(composition)
  configureDeviceRuntime(composition)
  configureBrowser(composition)
  configureProviderAccounts(composition)
  configureWorkflowRepositories(composition)
  configureHarnessQualifications(composition)
  configureHarnessProfiles(composition)
  configureWorkflowManagers(composition)
  configureExecutionCoordinator(composition)
  configureConversationManagers(composition)
  configureOperatorChat(composition)
  configureAgentChat(composition)
  configureOperatorServices(composition)
  configureHttpApplication(composition)
  configureRuntimeLifecycle(composition)
  configureRuntimeStartup(composition)
  configureRuntimeHooks(composition)
  return {
    app: composition.app,
    engine: composition.engine,
    prepareSchema: composition.prepareSchema,
    initialize: composition.initialize,
    reconcile: composition.reconcile,
    shutdown: composition.shutdown,
    drainShutdown: composition.drainShutdown,
    rsync: composition.rsync,
    shutdownPending: () => composition.lifecycle.pending(),
    registerFileStorage: () => {
      composition.fileStorage ??= registerProductionFileStorage(composition.app, composition.database.pool, composition.config)
      composition.mountArtifacts()
      return composition.fileStorage
    },
    startDeviceListener: () => composition.deviceRuntime.startListener(),
  }
}

function configureBrowser(composition: ProductionComposition) {
  const { config, database, deviceRuntime } = composition
  const reportFailure = (error: unknown) => componentLogger('harness').warn({ err: error }, 'Browser runtime requires attention')
  composition.browser = createProductionBrowser({ pool: database.pool,
    stateDirectory: config.browserStateDirectory ?? resolve(config.harnesses.workspaceRoot, 'browser-state'),
    runtimeRoot: config.browserRuntimeRoot,
    binding: id => deviceRuntime.currentBinding(id),
    assertHostOwnership: async () => {
      if (!composition.runtimeOwner?.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The browser runtime owner is unavailable.', 503)
    }, reportFailure,
    remote: (pairing, authority) => {
      const remote = createMainBrowserRemote({ pool: database.pool, pairing, authority,
        endpoint: () => deviceRuntime.endpointForDomains(), browser: () => composition.browser, reportFailure })
      composition.browserRemote = remote
      return remote
    },
  })
  composition.collaborationPorts = { ...composition.collaborationPorts, browser: composition.browser.lifecycle }
}

function configureMainTransport(composition: ProductionComposition) {
  const {
    config,
    database,
    codexChatFiles,
    qualificationSuites,
    infrastructure,
  } = composition
  const mainCodex = composition.mainCodex = new MainCodexSelection(config.harnesses.codexBinary,
    resolve(config.harnesses.workspaceRoot, 'main-codex-selection.json'), systemMaintenancePorts())
  composition.mainBinaries = { get codexBinary() { return mainCodex.binary } }
  composition.workerExecution = new WorkerExecutionPolicy(config.workerExecution)
  if (infrastructure?.mode === 'replay' && (!infrastructure.auxiliary
    || !infrastructure.auxiliary.compatibility || !infrastructure.auxiliary.plugins
    || !infrastructure.auxiliary.mcp?.codex
    || !infrastructure.auxiliary.command || !infrastructure.auxiliary.recovery || !infrastructure.inventoryDiscovery || qualificationSuites)) {
    throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay must inject settings and probes and cannot run installed CLI qualification.', 500)
  }
  const fileStorageRoot = composition.fileStorageRoot = config.fileStorageRoot ?? defaultFileStorageRoot()
  composition.chatFileAdmissions = codexChatFiles ?? postgresCodexChatFiles(database.pool, () => {
    if (!composition.fileStorage) throw new Error('Production file storage is not registered.')
    return composition.fileStorage
  }, () => localCodexChatHost(fileStorageRoot), codexChatHostDirectory(fileStorageRoot))
  composition.responseJournal = new NativeResponseJournal(resolve(config.harnesses.workspaceRoot, 'native-response-receipts'))
  composition.processRegistry = infrastructure?.auxiliary?.recovery
    ?? new NativeProcessRegistry(resolve(config.harnesses.workspaceRoot, 'native-process-registry'))
  composition.access = new PostgresAccessService(database.pool)
  const inputAcknowledgements = composition.inputAcknowledgements = new Map<string, TransferIntent>()
  const acceptedRsync = composition.acceptedRsync = {
    async intent(id, binding) {
      if (!composition.jobRuntime) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Original Main source and Job transfer services have not initialized.', 503)
      if (!isDeepStrictEqual(composition.deviceRuntime.endpointForDomains().captureRequest(binding.deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding, binding))
        throw new DomainError('RSYNC_CONNECTION_CONFLICT', 'Transfer lookup requires the actual current rsync channel.', 403)
      const operation = await requireRsyncTransferOwner(database.pool, id)
      if (operation === 'source.package.admit') return composition.jobRuntime.transfers.intent(id, binding)
      if (operation === 'job.inputs.bind') {
        return composition.jobRuntime.inputs.main.authorizedTransfer(id, transferContextForBinding(binding))
      }
      const intent = await composition.jobRuntime.outputs.admission.intentForTransfer(id)
      await composition.jobRuntime.outputs.admission.authorizeTransfer(intent, transferContextForBinding(binding))
      return intent
    },
    async authorize(intent, context) {
      const binding = composition.deviceRuntime.endpointForDomains().captureRequest(intent.deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding
      if (!binding || !isDeepStrictEqual(transferContextForBinding(binding), context) || !isDeepStrictEqual(await acceptedRsync.intent(intent.transferId, binding), intent))
        throw new DomainError('RSYNC_TRANSFER_DENIED', 'The original accepted transfer or authenticated generation changed.', 403)
    },
  }
  const entrypoint: ProductionComposition['entrypoint'] = composition.entrypoint = infrastructure?.rsyncInstallation?.kind === 'configured' && !infrastructure.rsync
    ? createMainRsyncEntrypoint({ installation: infrastructure.rsyncInstallation, endpoint: () => composition.deviceRuntime.endpointForDomains(), accepted: acceptedRsync,
      setup: { checkAcceptedTransfer: (...args) => {
        if (!composition.trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The original Main trusted connection authority has not initialized.', 503)
        return composition.trustedConnections.checkAcceptedTransfer(...args)
      }, readAcceptedTransfer: (...args) => {
        if (!composition.trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Connection consent is unavailable.', 503)
        return composition.trustedConnections.readAcceptedTransfer(...args)
      } },
      ownership: () => rsync.kind === 'configured' ? rsync.ownership : undefined }) : undefined
  const installedRsync: ProductionComposition['installedRsync'] = composition.installedRsync = infrastructure?.rsync ?? entrypoint?.providers
  const rsyncProviders: InstalledMainRsyncProviders | undefined=installedRsync?{...installedRsync,acknowledged:async(...args:Parameters<NonNullable<InstalledMainRsyncProviders['acknowledged']>>)=>{
    const [intent,context]=args
    const binding=composition.deviceRuntime.endpointForDomains().captureRequest(intent.deviceId,RSYNC_STAGE_EXTENSION.namespace)?.binding
    if(!binding||!isDeepStrictEqual(transferContextForBinding(binding),context))throw new DomainError('RSYNC_CONNECTION_CONFLICT','Canonical ACK requires the original actual Main capture.',403)
    if(intent.byteClass==='source'&&intent.direction==='to-worker'){
      if(!composition.jobRuntime)throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE','The original committed source lifecycle is unavailable.',503)
      await composition.jobRuntime.lifecycle.acknowledged(intent,context)
    }else if(intent.byteClass==='artifact'&&intent.direction==='to-main'&&composition.jobRuntime&&await composition.jobRuntime.outputs.ownsTransfer(intent.transferId)){
      await composition.jobRuntime.outputs.admission.authorizeTransfer(intent,context)
      await composition.jobRuntime.outputs.lifecycle.acknowledged(intent)
    }else if(isDeepStrictEqual(inputAcknowledgements.get(intent.transferId),intent)){
      if(!composition.jobRuntime)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The original input delivery authority is unavailable.',503)
      await composition.jobRuntime.inputs.main.acknowledged(intent.transferId,binding)
    }else await installedRsync.acknowledged(...args)
  }}:undefined
  const rsync: ProductionComposition['rsync'] = composition.rsync = createInstalledRsyncComposition({ side: 'main', providers: rsyncProviders,
    current: deviceId => composition.deviceRuntime.endpointForDomains().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding })
  composition.remoteTelemetry = createMainResourceTelemetryBindings(() => composition.telemetry?.service)
}

function configureDeviceRuntime(composition: ProductionComposition) {
  const {
    database,
    infrastructure,
    acceptedRsync,
    rsync,
    remoteTelemetry,
  } = composition
  const deviceRuntime = composition.deviceRuntime = new ProductionDeviceRuntime(database.pool, infrastructure?.deviceListener, {
    workerArtifacts: workerArtifactLocation({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
    browserMedia: (request, socket, head) => composition.browserRemote.mediaUpgrade(request, socket, head),
    extensions: [
      remoteTelemetry.extension,
      ...rsync.extensions.map(extension => ({ ...extension, role: 'duplex' as const, async handle(raw: unknown, context: import('./modules/devices/deviceApplicationChannel.js').DeviceExtensionContext) {
        context.signal.throwIfAborted()
        if (context.bytes !== undefined) throw new DomainError('RSYNC_TRANSFER_DENIED', 'Transfer authorization accepts metadata only.', 403)
        const request = RsyncTransferAuthorizeRequestSchema.parse(raw)
        const intent = await acceptedRsync.intent(request.transferId, context.binding)
        context.signal.throwIfAborted()
        return { payload: intent }
      } })),
      { ...BROWSER_DEVICE_EXTENSION, handle: (payload, context) => composition.browserRemote.handle(payload, context) },
      { namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version, role: 'client', maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0 },
      { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = composition.jobRuntime?.qualificationExtension.handle
        if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual diagnostic qualification authority is unavailable.', 503)
        return handler(payload, context)
      } },
      { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', async handle(payload, context) {
        if (!composition.executionAuthority?.handle) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Main Agent placement authority has not initialized.', 503)
        return composition.executionAuthority.handle(payload, context)
      } },
      { namespace: WORKER_MCP_EXTENSION.namespace, version: WORKER_MCP_EXTENSION.version, role: 'server',
        maxJsonBytes: WORKER_MCP_EXTENSION.maxJsonBytes, maxBinaryBytes: WORKER_MCP_EXTENSION.maxBinaryBytes, async handle(raw, context) {
          const payload = decodeWorkerMcpRequest({ payload: raw, ...(context.bytes ? { bytes: context.bytes } : {}) })
          if (payload && typeof payload === 'object' && 'operation' in payload
            && typeof payload.operation === 'string' && payload.operation.startsWith('conversation-mcp.')) {
            return encodeWorkerMcpResult(await composition.workerChats.mcp.handle(payload, context.binding, context.signal))
          }
          if (!composition.mainWorkerMcp) throw new DomainError('WORKER_MCP_UNAVAILABLE', 'The original Main worker MCP authority has not initialized.', 503)
          context.signal.throwIfAborted()
          const result = await composition.mainWorkerMcp.handle(payload, context.binding, context.signal)
          context.signal.throwIfAborted()
          return encodeWorkerMcpResult(result)
        } },
      { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = composition.jobRuntime?.sourceExtension.handle
        if (!handler) throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE', 'The actual Main source domain has not initialized.', 503)
        return handler(payload, context)
      } },
      createMainWorkflowArtifactTransferExtension(() => composition.workflowArtifacts?.receiver,
        infrastructure?.deviceDomains?.extensions.find(value => value.namespace === BYTE_TRANSFER_NAMESPACE),()=>composition.jobRuntime?.outputs),
      { namespace: 'harness-discovery-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'provider-accounts-v1', version: 1, role: 'duplex', maxJsonBytes: 65_536, maxBinaryBytes: 0,
        async handle(raw, context) {
          const request = ProviderAccountWorkerAuthorityRequestSchema.parse(raw)
          const target = request.kind === 'binding' ? request.binding.target : request.operation.binding.target
          const current = deviceRuntime.endpointForDomains().currentBinding(context.binding.deviceId)
          if (context.bytes !== undefined || !isDeepStrictEqual(current, context.binding)
            || target.hostRef.kind !== 'device' || target.hostRef.deviceId !== context.binding.deviceId
            || target.hostRef.mainId !== context.binding.mainId
            || target.applicationInstallationId !== context.binding.workerInstallationId
            || target.keyRevision !== context.binding.keyRevision
            || target.authorizationRevision !== context.binding.authorizationRevision) {
            throw new DomainError('ACCESS_DENIED', 'The original Worker account authority is unavailable.', 403)
          }
          let payload: { available: true } | { allowed: true }
          if (request.kind === 'binding') {
            const resolved = await composition.providerAccounts.resolve(request.binding.provider, request.binding.accountId,
              { allowDefault: false, acceptedBinding: request.binding })
            if (!resolved) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted account is unavailable.', 409)
            payload = { available: true }
          } else {
            await composition.providerAccounts.assertAuthenticationEligibility(request.operation)
            payload = { allowed: true }
          }
          if (!isDeepStrictEqual(current, deviceRuntime.endpointForDomains().currentBinding(context.binding.deviceId))) {
            throw new DomainError('ACCESS_DENIED', 'The original Worker account channel changed.', 403)
          }
          return { payload }
        } },
      { namespace: COMPUTER_ACCOUNTS_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 65_536, maxBinaryBytes: 0 },
      { namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      createProductionWorkerArtifactExtension({
        pool: database.pool,
        environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)),
      }),
      { namespace: COMPUTER_GITHUB_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16_384, maxBinaryBytes: 0 },
      { namespace: MANAGED_MCP_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: COMPUTER_SYNC_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: AGENT_SNAPSHOT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: AGENT_SNAPSHOT_JSON_BYTES, maxBinaryBytes: 0 },
      { namespace: CI_RUNTIME_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: CI_HOST_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'host-harness-check-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { ...REMOTE_PREPARATION_EXTENSION, role: 'client' },
      { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
        handle: async (payload, context) => {
          if (WorkerConversationCallbackSchema.safeParse(payload).success) {
            if (!composition.workerChats || context.bytes !== undefined) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE',
              'The Main conversation callback authority is unavailable.', 503)
            return { payload: await composition.workerChats.bridge.handle(payload, context.binding, context.signal) }
          }
          if (RemoteJobMainRpcRequestRecordSchema.safeParse(payload).success) {
            if (!composition.jobRuntime) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual main Job application bridge is unavailable.', 503)
            return { payload: await composition.jobRuntime.application.handle(payload, context.binding) }
          }
          const native = infrastructure?.deviceDomains?.extensions.find(value => value.namespace === 'execution-v1')
          if (!native?.handle) throw new DomainError('REMOTE_WORKFLOW_RPC_UNAVAILABLE', 'The actual main workflow application bridge is unavailable.', 503)
          return native.handle(payload, context)
        } },
      { namespace: JOB_INPUT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 8192,
        handle: async (payload, context) => {
          const handler = composition.jobRuntime?.inputs.extension.handle
          if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual Job input authority is unavailable.', 503)
          return handler(payload, context)
        } },
      ...(infrastructure?.deviceDomains?.extensions.filter(value => !['execution-v1', REMOTE_PREPARATION_EXTENSION.namespace, JOB_INPUT_NAMESPACE, BYTE_TRANSFER_NAMESPACE,
        remoteTelemetry.extension.namespace].includes(value.namespace)) ?? []),
    ],
    async bindingLost(binding) {
      const tasks: Promise<unknown>[] = []
      tasks.push(remoteTelemetry.lost(binding))
      try { if (rsync.kind === 'configured') tasks.push(rsync.rsyncWriters.bindingLost(binding)) } catch (error) { tasks.push(Promise.reject(error)) }
      try { const task = infrastructure?.deviceDomains?.bindingLost?.(binding); if (task) tasks.push(task) } catch (error) { tasks.push(Promise.reject(error)) }
      const results = await Promise.allSettled(tasks), failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original device domain binding cleanup remains incomplete')
    },
    async bindingReady(binding, signal, endpoint) {
      if (!signal.aborted) {
        composition.browser.profiles.wake()
        composition.jobRuntime?.requestQueueWake()
        composition.runtimeServices.ciEnrollment?.request({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        })
        void composition.runtimeServices.ci?.dispatch()
      }
      if (composition.runtimeServices.computerSync) {
        void composition.runtimeServices.computerSync.paired({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        }).catch(error => composition.app.log.warn({ err: error, deviceId: binding.deviceId }, 'Shared file pairing is pending'))
      }
      composition.installationMonitor.workerReady(binding, signal)
      try {
        const session = await remoteTelemetry.ready(binding, signal, endpoint)
        if (session) void session.completion.catch(error => {
          if (!signal.aborted) composition.app.log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector failed')
        })
      } catch (error) {
        if (!signal.aborted) composition.app.log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector did not start')
      }
    },
    async reconcile(binding, signal, endpoint) {
      if (endpoint.capabilities(binding.deviceId).some((item) => item.namespace === 'harness-discovery-v1' && item.mainCanRequest)) {
        const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
          { operation: 'discover', refreshId: randomUUID() }, { signal })
        signal.throwIfAborted()
        if (composition.selectedSuites) await retainInstalledHarnessInventory({ registry: composition.harnessRegistry, qualifications: composition.qualificationRepository,
          binding, inventory: result.payload, suiteRevision: composition.selectedSuites.codex.revision })
        else composition.harnessRegistry.acceptRemoteSnapshot(binding, result.payload)
      }
      if (infrastructure?.deviceDomains) await infrastructure.deviceDomains.reconcile(binding, signal, endpoint)
    },
  })
}

function configureProviderAccounts(composition: ProductionComposition) {
  const {
    config,
    database,
    accountSelection,
    processRegistry,
    deviceRuntime,
  } = composition
  const commands = composition.commands = new PostgresCommandCoordinator(database.pool)
  composition.bugReports = new BugReportService(database.pool, commands)
  const accountCredentials = new LocalProviderCredentials(resolve(config.harnesses.workspaceRoot, 'provider-accounts'))
  const selectedAccounts: ProductionComposition['selectedAccounts'] = composition.selectedAccounts = accountSelection ?? createProductionAccountSelection({
    path: resolve(config.harnesses.workspaceRoot, 'provider-account-qualifications.json'),
    managedPaths: accountId => accountCredentials.paths(accountId),
    validate: () => composition.harnessRegistry.refreshMain(),
    pin: record => composition.harnessRegistry.pinOverride(record.override),
    models: async (binding, generation) => {
      const options = await composition.nativeConfigurations.options(binding.provider, binding)
      const selected = selectedAccounts.selectAccount?.(binding)
      if (!selected) throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'Account model installation is unavailable.', 409)
      return { binding, generation, observedAt: options.checkedAt,
        models: options.models.map(row => ({ ...row, name: row.name ?? row.id })), options }
    },
  })
  const accountCommands = new NativeProviderAccountCommands(selectedAccounts)
  const accountNative: NativeProviderAccountOperations | NativeProviderAccountCommands = processRegistry instanceof NativeProcessRegistry
    ? new NativeProviderAccountOperations(accountCommands,
      new NativeAccountJournal(resolve(config.harnesses.workspaceRoot, 'provider-account-operations')), processRegistry,
      input => providerAccounts.assertAuthenticationEligibility(input.operation))
    : accountCommands
  const providerAccounts: ProductionComposition['providerAccounts'] = composition.providerAccounts = new ProviderAccountsService(database.pool,
    new ProviderAccountsRepository(database.pool, () => accountCredentials.hostId()), accountCredentials,
    accountNative, commands)
  providerAccounts.bindTarget(async sql => {
    const row = (await sql.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]
    if (!row) throw new DomainError('PROVIDER_ACCOUNT_TARGET_UNAVAILABLE', 'The canonical Main installation is unavailable.', 503)
    return { hostRef: { kind: 'main', mainId: row.id }, applicationInstallationId: row.id,
      keyRevision: null, authorizationRevision: null }
  })
  providerAccounts.bindRouting(createRemoteAccountServices({ pool: database.pool, commands, local: providerAccounts,
    endpoint: () => deviceRuntime.endpointForDomains() }))
  composition.workflowAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  composition.accountConfigurations = new ProviderAccountConfigurationService(providerAccounts)
  const workflowCapture = composition.workflowCapture = createWorkflowNativeCaptureChannel()
  composition.reviewCapture = createReviewNativeCaptureChannel()
  composition.memoryBoards = createMemoryBoardService(database.pool, memoryBoardAuthority)
  composition.workflowRuntime = createWorkflowRepositoryServices(workflowCapture.verify, (sql, owner, capture) => {
    if (!composition.remoteWorkflow) throw new DomainError('REMOTE_WORKFLOW_UNAVAILABLE', 'The actual original native physical composition is unavailable.', 503)
    return composition.remoteWorkflow.assertPhysical(sql, owner, capture)
  }, async (sql, evidence, proof) => {
    // Event file contexts are admitted at turn start; artifact results arrive in captured history.
    if (proof.original.type === 'event' && proof.original.event.type !== 'turn.started') return
    if (!composition.admitWorkflowFileContext) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original Main file-context composition is unavailable.', 503)
    await composition.admitWorkflowFileContext(sql, evidence, proof)
    if (await workflowArtifactsAreLocal(sql, proof.scope.runId, proof.ref.nodeId)) {
      const snapshot = await readAcceptedRepeatRunLocked(sql, proof.scope.runId)
      const node = snapshot.version.definition.nodes.find(item => item.id === proof.ref.nodeId)
      if (node && node.kind !== 'job' && node.artifactOutputs) {
        if (!composition.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await composition.localWorkflowArtifacts.admitContextLocked(sql, workflowCapture.verify.read(evidence), proof)
      }
      return
    }
    await composition.artifactResultSource?.retainOriginalLocked(sql, evidence, proof)
  })
}

function configureWorkflowRepositories(composition: ProductionComposition) {
  const {
    config,
    database,
    qualificationSuites,
    infrastructure,
    mainBinaries,
    workerExecution,
    processRegistry,
    deviceRuntime,
    commands,
    accountConfigurations,
    workflowCapture,
    reviewCapture,
    workflowRuntime,
  } = composition
  const collaboration = composition.workflowCollaboration = new WorkflowCollaborationIntegration(
    composition.collaborationPorts, async (owner, execution) => {
      const placement = await owner.oneShotConnection().transaction(sql =>
        readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId), true)
      if (placement) return placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : placement.hostRef.mainId
      const mainId = composition.artifactComposition?.mainId
      if (!mainId) throw new DomainError('BROWSER_COMPUTER_UNAVAILABLE', 'The accepted Main computer is unavailable.', 503)
      return mainId
    })
  const workflowServices: RepeatRepositoryServices = { ...workflowRuntime.services,
    collaboration: collaboration.hooks,
    prepareCollaborationExecution: (owner, run, version, execution) => collaboration.prepare(owner, run, version, execution),
    readCollaborationPrompt: (owner, execution, version) => collaboration.readPrompt(owner, execution, version),
    releaseCollaborationExecution: (owner, execution, version) => collaboration.release(owner, execution, 'terminal', version),
    memoryBoards: composition.memoryBoards,
    async reconcileWorkflowArtifacts(owner, run, execution, signal) {
      signal.throwIfAborted()
      const snapshot = await runs.getRepeatSnapshot(run.id, owner)
      const node = snapshot.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
      if (!node || node.kind === 'job' || !node.artifactOutputs) return
      if (await workflowArtifactsAreLocal(database.pool, execution.runId, execution.workflowNodeId)) {
        if (!composition.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await composition.localWorkflowArtifacts.recover(owner, execution, signal)
        return
      }
      if (!composition.artifactComposition || !composition.workflowArtifacts) {
        throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original artifact composition is unavailable.', 503)
      }
      await recoverWorkflowArtifactOutputs({ owner, execution, authority: composition.artifactComposition.authority,
        outputs: composition.workflowArtifacts.artifacts.outputs })
    },
    async assertWorkflowArtifactOutputsLocked(sql, run, version, execution) {
      if (await workflowArtifactsAreLocal(sql, execution.runId, execution.workflowNodeId)) {
        if (!composition.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await composition.localWorkflowArtifacts.assertOutputsLocked(sql, run, version, execution)
        return
      }
      if (!composition.artifactOutputsGate) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact acceptance composition is unavailable.', 503)
      await composition.artifactOutputsGate(sql, run, version, execution)
    },
    async admitPlacementExecutionLocked(sql, owner, run, execution, ref, inputDigest) {
      if (composition.agentPlacement) { await composition.agentPlacement.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId); return }
      if (await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent placement producer is unavailable.', 503)
    },
    async preparePlacementExecution(owner, run, execution) {
      if (!composition.artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
      await owner.oneShotConnection().transaction(sql => composition.artifactResultSource!.assertLaunchDeclarationLocked(sql, execution.id, run.id))
      if (composition.agentPreparation) {
        const prepared = await composition.approvals.withSourceObservationLane(owner, execution, () => composition.agentPreparation!.prepare(owner, run, execution))
        if (prepared) return { ...prepared, revalidate: () => composition.approvals.withSourceObservationLane(owner, execution, prepared.revalidate) }
      }
      const placed = await owner.oneShotConnection().transaction(sql => readAcceptedPlacement(sql, run.id, execution.workflowNodeId))
      if (placed) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent source preparation producer is unavailable.', 503)
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
      const configuration = await workflows.getAgentConfiguration(execution.agentConfigurationVersionId)
      if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The accepted Agent configuration is unavailable.', 409)
      const access = requiredLocationAccess([configuration])
      await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
      const tree = await runWorktrees.prepare(run, AbortSignal.timeout(60_000), execution.id)
      if (!tree) return undefined
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(config.harnesses.workspaceRoot, { workspaceId: run.workspaceId,
          workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, execution),
        revalidate: async () => {
          owner.assertOwned()
          await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
          await runWorktrees.verify(tree)
        } }
    },
  }
  const reviewNativeProofs = new ReviewNativeProofServices(reviewCapture.verify,
    (sql, capture) => remoteWorkflow.assertReviewPhysical(sql, capture))
  composition.repository = new PostgresInteractionRepository(database.pool, reviewNativeProofs)
  composition.budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = composition.projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const runWorktrees = composition.runWorktrees = new RunWorktrees(database.pool, join(config.harnesses.workspaceRoot, 'run-worktrees'))
  const locations = composition.locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot, 'runner-local')
  const workflows = composition.workflows = new PostgresWorkflowRepository(database.pool)
  const runs = composition.runs = new PostgresRunRepository(database.pool, workflows, locations,
    { runtimeRoot: config.harnesses.workspaceRoot, ...workflowRuntime, services: workflowServices }, async evidence => {
      const accepted = composition.artifactResultSource?.acceptedAfterCommit(evidence)
      if (accepted) {
        if (!composition.workflowArtifacts || !composition.artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
        await new WorkflowArtifactResultAdoption(composition.artifactResultSource.source, composition.workflowArtifacts.artifacts.outputs).adoptOriginalOutputs(accepted)
        await composition.artifactResultSource.assertAdoptedAfterCommit(evidence)
      }
      try { await remoteWorkflow.afterCommit(workflowCapture.verify.read(evidence)) }
      catch (error) { composition.app.log.warn({ err: error }, 'Original remote metadata acknowledgment remains pending') }
    })
  const remoteWorkflow = composition.remoteWorkflow = createProductionRemoteWorkflow({ pool: database.pool, locations, endpoint: () => deviceRuntime.endpointForDomains(),
    preparationTimeoutMs: config.harnesses.timeoutMs,
    workerExecution,
    producer: () => composition.agentPlacement, execution: id => runs.getExecution(id), artifacts: {
      assertPublications: (sql, readout, binding) => {
        if (!composition.workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return composition.workflowPhysicalArtifacts.assertPublications(sql, readout, binding)
      },
      assertAdopted: (sql, readout, binding) => {
        if (!composition.workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return composition.workflowPhysicalArtifacts.assertAdopted(sql, readout, binding)
      },
    } })
  composition.workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = composition.settings = new PostgresSettingsRepository(database.pool)
  const hostProfileEvidence = composition.hostProfileEvidence = new HostHarnessProfileEvidenceRepository(database.pool)
  const claudeDiscovery: ProductionComposition['claudeDiscovery'] = composition.claudeDiscovery = createClaudeProductionDiscovery({ registry: () => harnessRegistry, factories: () => composition.nativeFactories,
    workingDirectory: config.harnesses.workspaceRoot })
  const harnessRegistry: ProductionComposition['harnessRegistry'] = composition.harnessRegistry = new ProductionHarnessRegistry(database.pool, mainBinaries,
    (client) => settings.getManagedHarnessDefaults(client), hostProfileEvidence,
    (deviceId) => { const view = deviceRuntime.presenceFor(deviceId); return view?.phase === 'ready' ? view.binding : null },
    process.env, infrastructure?.inventoryDiscovery ?? { launcher: discoverInventoryLauncher, payloads: inventoryDriverPayloads,
      claude: claudeDiscovery.discover }, (deviceId) => deviceRuntime.currentBinding(deviceId),
    (deviceId) => deviceRuntime.presenceFor(deviceId))
  const foundationSettings = composition.foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  composition.remoteExecution = new RemoteExecutionSettingsService(foundationSettings, commands, workerExecution,
    deviceRuntime, remoteExecutionStartupEnvironment({ listener: infrastructure?.deviceListener,
      workerExecution: config.workerExecution, environment: config.remoteExecutionEnvironment ?? {} }), config.port,
    error => composition.app.log.error({ err: error }, 'device listener settings could not be applied'))
  composition.operators = new PostgresOperatorRepository(database.pool, accountConfigurations)
  composition.rollout = new NativeRollout(process.env)
  composition.compatibilityProbe = (timeoutMs = 2000, expected?: { harness: CompatibilityHarness; binary: string }) => scopedCompatibilityProbe({
    registry: processRegistry, pin: (harness) => {
      const binding = harnessRegistry.pinDefault(harness)
      if (expected && (harness !== expected.harness || binding.installation.launcher.resolvedLauncher !== expected.binary)) {
        throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'Diagnostics require the original inspected launcher.', 409)
      }
      return binding
    },
    assertInstallation: (binding, signal) => composition.nativeFactories.assertInstallationUnchanged(binding, signal),
    workingDirectory: config.harnesses.workspaceRoot, environment: process.env, timeoutMs,
  })
  composition.qualificationRepository = new HarnessQualificationRepository(database.pool)
  const identity = infrastructure?.qualificationIdentity ?? {
    registry: harnessRegistry.installations, pin: (harness: CompatibilityHarness) => harnessRegistry.pinDefault(harness),
  }
  composition.selectedSuites = qualificationSuites && identity ? {
    codex: withQualificationIdentity(withNativeQualificationOwnership(qualificationSuites.codex, processRegistry,
      (input) => { const binding = identity.pin('codex', input); return (signal) => composition.nativeFactories.assertInstallationUnchanged(binding, signal) }), identity.registry, (input) => identity.pin('codex', input)),
  } : qualificationSuites
}

function configureHarnessQualifications(composition: ProductionComposition) {
  const {
    config,
    database,
    infrastructure,
    mainCodex,
    responseJournal,
    processRegistry,
    access,
    commands,
    selectedAccounts,
    providerAccounts,
    settings,
    hostProfileEvidence,
    claudeDiscovery,
    harnessRegistry,
    compatibilityProbe,
    qualificationRepository,
    selectedSuites,
  } = composition
  const qualificationRegistry = composition.qualificationRegistry = selectedSuites ? new HarnessQualificationRegistry(qualificationRepository, {
    codex: selectedSuites.codex.revision,
  }) : undefined
  composition.harnessQualifications = selectedSuites && qualificationRegistry ? new HarnessQualificationService(
    qualificationRepository, qualificationRegistry, selectedSuites,
    { get codex() { return mainCodex.binary } }, commands, settings,
    undefined, (harness) => harnessCompatibility.refreshAfterQualification(harness),
    (harness, binary, timeoutMs) => compatibilityProbe(timeoutMs, { harness, binary }),
    (harness, signal) => {
      if (harness !== 'codex') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Unsupported qualification driver.', 409)
      return harnessRegistry.refreshMain(signal)
    },
    harness => commandInputHash(qualificationIdentity(harnessRegistry.pinDefault(harness), selectedSuites[harness].revision)),
  ) : undefined
  const harnessCompatibility = composition.harnessCompatibility = infrastructure?.auxiliary
    ? new HarnessCompatibilityService({ ...infrastructure.auxiliary.compatibility, commands })
    : new HarnessCompatibilityService({ probe: compatibilityProbe(), cache: new FileCompatibilityCache(), commands })
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  composition.appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp`
  composition.nativeFactories = new NativeHarnessFactories({ get codexBinary() { return mainCodex.binary }, responseJournal,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    refreshInstallations: signal => harnessRegistry.refreshMain(signal),
    instances: harnessRegistry.instances, installations: harnessRegistry.installations,
    selectDefault: (harness) => harnessRegistry.pinDefault(harness),
    selectConfiguration: (configuration) => harnessRegistry.pinAccepted({
      id: `configuration-check:${commandInputHash(configuration)}`, agentId: 'configuration-qualification', harness: configuration,
    }),
    ...(infrastructure?.inventoryDiscovery ? { installationDiscovery: infrastructure.inventoryDiscovery.launcher } : {}),
    auxiliaryRecovery: (role) => processRegistry.scope(`${role}:${infrastructure?.mode === 'replay' ? infrastructure.codex.id() : randomUUID()}`),
    admitRecovery: async (recovery) => { Object.assign(recovery, await processRegistry.reserveLaunch(recovery.owner)) },
    abandonRecovery: async (recovery) => { await processRegistry.abandonReservedLaunch(recovery) },
    claudeVersionCommand: infrastructure?.auxiliary?.command ?? runCommand,
    closeRecovery: async (recovery) => {
      if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
    },
  }, infrastructure)
  composition.hostSettings = new HarnessInstanceSettingsRepository(database.pool)
  composition.hostAuthority = { async authorize(principal, action, hostRef, applicationInstallationId, client) {
    if (client) { await authorizeDeviceHost(client, principal, action, hostRef, applicationInstallationId); return }
    await withTransaction(database.pool, async (connection) => {
      await authorizeDeviceHost(connection, principal, action, hostRef, applicationInstallationId)
    })
  } }
  composition.profileAuthority = {
    async authorize(binding, selector, client) {
      binding.admissionSignal?.throwIfAborted()
      if (binding.kind === 'workflow' && binding.purpose === 'consultation') {
        if (!binding.consultation) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation profile requires its mailbox binding.', 409)
        const current = await readCoordinatorCredentialAuthority(client, binding.consultation)
        if (current.run_id !== binding.runId || current.execution.id !== binding.executionId
          || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation source attempt changed.', 409)
        const owner = binding.getOwner()
        if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation Run owner is unavailable.', 409)
        owner.assertOwned()
        const row = (await client.query<{ principal_id: string }>(
          "select record->>'authorizationPrincipalId' as principal_id from runs where id=$1", [binding.runId])).rows[0]
        if (!row) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principal_id)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.workspace_id, workflowId: current.workflow_id })
      } else if (binding.kind === 'workflow') {
        const current = await credentialAuthority(client, binding.executionId,
          binding.purpose === 'reviewer' ? 'reviewer' : 'workflow')
        if (current.run.id !== binding.runId || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt changed.', 409)
        if (!current.nativeSessionId && binding.purpose !== 'reviewer') {
          const owner = binding.getOwner()
          if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The original native launch owner is unavailable.', 409)
          owner.assertOwned(); await owner.readOneShotFence(owner.client)
        }
        const row = (await client.query<{ principal_id: string }>("select record->>'authorizationPrincipalId' as principal_id from runs where id=$1", [binding.runId])).rows[0]
        if (!row?.principal_id) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run principal is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principal_id)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.run.workspaceId, workflowId: current.run.workflowId })
      } else if (binding.kind === 'operator-observation') {
        await authorizeOperatorProfileObservation(client, binding, selector)
      } else if (binding.kind === 'operator-inspection') {
        const principal = await access.currentHarnessInspectionPrincipal(binding.principalId, client)
        requireAuthorization(principal, 'harnesses:read')
        await authorizeOperatorConfigurationRead(client, principal, binding.configurationVersionId)
        const row = (await client.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1 and operator_id=$2',
          [binding.configurationVersionId, 'application-operator'])).rows[0]
        const configuration = row ? OperatorConfigurationVersionSchema.parse(row.record) : undefined
        if (!configuration || configuration.contentHash !== binding.configurationHash || !isDeepStrictEqual(configuration.harnessProfileSelection, selector)) {
          throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact saved Operator configuration changed before its read-only inspection.', 409)
        }
      } else await new PostgresClaudeInteractionAuthority(client, binding, { nativeCallbackContext: () => undefined }).profileAdmission()
      await assertDeviceHostInstallation(client, selector.target.hostRef, selector.target.applicationInstallationId)
      binding.admissionSignal?.throwIfAborted()
    },
    async current(binding, value, client, options) {
      if (value.driverId === 'claude') {
        await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
        if (value.target.hostRef.kind === 'device') {
          const registry = harnessRegistry.pinOverride(value)
          const proof = await hostProfileEvidence.latest(value.instanceId, value.revision, client)
          const pin = installedClaudeProfilePin(value, registry, proof)
          harnessRegistry.installations.assertCurrent(registry)
          return { registry, pin, applicationInstallationId: value.target.applicationInstallationId,
            suiteRevision: CLAUDE_PROFILE_CHECK_REVISION }
        }
        const current: AcceptedProfileAuthority<ClaudeProfileOwner>['current'] | undefined = infrastructure?.claudeCurrentProfile
          ?? (infrastructure?.mode === 'replay' ? undefined : claudeDiscovery.current)
        if (!current) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude replay requires its current installed profile metadata port.', 500)
        return current(binding, value, client, options)
      }
      if (binding.kind !== 'operator-observation' && !await harnessRegistry.profileEvidence(value, client, options)) {
        throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile proof is stale.', 409)
      }
      return { registry: harnessRegistry.pinOverride(value), applicationInstallationId: value.target.applicationInstallationId,
        suiteRevision: `${value.driverId}-profile-check-v1` }
    },
    assertCurrent: binding => harnessRegistry.installations.assertCurrent(binding),
    assertReady: profile => composition.hostProfileChecks.assertReady(profile),
  }
}

function configureHarnessProfiles(composition: ProductionComposition) {
  const {
    config,
    database,
    infrastructure,
    mainCodex,
    workerExecution,
    processRegistry,
    deviceRuntime,
    commands,
    selectedAccounts,
    providerAccounts,
    accountConfigurations,
    projectRoot,
    settings,
    hostProfileEvidence,
    claudeDiscovery,
    harnessRegistry,
    qualificationRepository,
    selectedSuites,
    harnessQualifications,
    appMcpEndpoint,
    nativeFactories,
    hostSettings,
    hostAuthority,
    profileAuthority,
  } = composition
  composition.selectedProfiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  composition.claudeProfiles = infrastructure?.claudeProfiles ?? new AcceptedClaudeProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const hostProfileChecks = composition.hostProfileChecks = new HostHarnessInstanceProfileChecks(hostSettings, hostProfileEvidence, commands, hostAuthority,
    new ProductionHostHarnessProfileQualifier(harnessRegistry, nativeFactories, () => deviceRuntime.endpointForDomains(), config.harnesses.workspaceRoot,
      infrastructure?.mode === 'replay' ? undefined : { async qualify(value, input) {
        const apiKey = await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
        const current = await claudeDiscovery.currentForConfiguration(value, input.signal)
        const binding = harnessRegistry.pinOverride(value)
        const recovery = await processRegistry.reserveLaunch(`claude-profile-check:${input.checkId}`)
        const close = async () => {
          await processRegistry.abandonReservedLaunch(recovery)
          if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude native profile qualification closure is unconfirmed.')
        }
        try { return await qualifyClaudeNativeProfile({ value, checkId: input.checkId, binding, pin: current.pin,
          ...(apiKey ? { apiKey } : {}),
          directory: resolve(config.harnesses.workspaceRoot, 'claude-native-qualification'), recovery, signal: input.signal,
          assertCurrent: async () => { await nativeFactories.assertInstallationUnchanged(binding, input.signal); harnessRegistry.installations.assertCurrent(binding) } }) }
        finally { await close() }
      } }, workerExecution, providerAccounts), selectedSuites ? createInstalledNativeQualificationRetention({
      repository: qualificationRepository, suiteRevision: selectedSuites.codex.revision,
      currentBinding: deviceId => deviceRuntime.endpointForDomains().captureRequest(deviceId, 'host-harness-check-v1')?.binding ?? null,
      currentInstallation: value => harnessRegistry.pinOverride(value).installation,
      async refreshInstallation(value, signal) {
        if (value.target.hostRef.kind !== 'device') return
        const captured = deviceRuntime.endpointForDomains().captureRequest(value.target.hostRef.deviceId, 'harness-discovery-v1')
        if (!captured) throw new DomainError('HARNESS_INVENTORY_STALE', 'The qualified Worker connection is unavailable.', 409)
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)])
        const result = await captured.request({ operation: 'discover', refreshId: randomUUID() }, { signal: bounded })
        bounded.throwIfAborted()
        await retainInstalledHarnessInventory({ registry: harnessRegistry, qualifications: qualificationRepository,
          binding: captured.binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
      },
    }) : undefined)
  const harnessInstances = composition.harnessInstances = new HostHarnessOverrideService(hostSettings, commands, hostAuthority, async (value, client) => {
    await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
    const proof = await harnessRegistry.profileEvidence(value, client, { includeFailed: true })
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
      qualified: proof.qualified, ...(proof.failure ? { failure: proof.failure } : {}) } : null
  }, hostProfileChecks, configuration => {
    const binding = harnessRegistry.pinAccepted({ id: `operator-default-profile:${commandInputHash(configuration)}`, agentId: 'operator-default-setup', harness: configuration })
    const hostRef = binding.selection.hostRef
    if (hostRef.kind !== 'main' || !binding.installation.installationFingerprint) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The actual local Claude installation is unavailable.', 409)
    return { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: binding.selection.harnessInstallationId,
      installationFingerprint: binding.installation.installationFingerprint }
  }, accountConfigurations, value => hostProfileChecks.checkAutomatically(
    value, harnessRegistry.pinOverride(value).installation,
  ))
  accountConfigurations.bindProfiles(harnessInstances)
  composition.installationMonitor = new HarnessInstallationMonitor(harnessRegistry, hostProfileChecks,
    () => deviceRuntime.endpointForDomains(), async (binding, inventory) => {
      if (selectedSuites) await retainInstalledHarnessInventory({ registry: harnessRegistry,
        qualifications: qualificationRepository, binding, inventory, suiteRevision: selectedSuites.codex.revision })
      else harnessRegistry.acceptRemoteSnapshot(binding, inventory)
    }, async () => {
      if (!harnessQualifications) return
      const result = await harnessQualifications.verify('codex', { force: true })
      if (result.status !== 'qualified') throw new DomainError('HARNESS_REQUALIFICATION_FAILED',
        result.failureReason ?? 'The updated Codex installation failed its native checks.', 409)
    }, error => composition.app.log.error({ err: error }, 'Automatic harness installation checks failed'),
    infrastructure?.installationRefreshIntervalMs)
  const claudeMetadata = infrastructure?.mode === 'replay' ? undefined : productionClaudeMetadata({ registry: harnessRegistry,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    processes: processRegistry, factories: nativeFactories, settings: hostSettings, defaults: () => settings.getHarnessDefaults(), current: claudeDiscovery.currentForConfiguration })
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, nativeFactories, claudeMetadata, providerAccounts)
  const harnessCatalog = composition.harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot, appMcpEndpoint)
  const nativeConfigurations = composition.nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.workspaceRoot, nativeFactories, claudeMetadata, providerAccounts,
    { mainId: async () => (await database.pool.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]?.id ?? '',
    endpoint: () => deviceRuntime.endpointForDomains() },
  )
  composition.appRoutes = new AppMcpRoutes(database.pool, appMcpEndpoint, appLauncherPath(), () => composition.runtimeOwner)
  const maintenancePorts = composition.maintenancePorts = systemMaintenancePorts(process.env, { get codex() { return mainCodex.binary } })
  maintenancePorts.selectInstalledCodex = async signal => {
    const binary = await mainCodex.selectInstalled(signal)
    await harnessRegistry.refreshMain(signal)
    harnessCatalog.invalidateChecks()
    nativeConfigurations.invalidateOptions()
    return binary
  }
  composition.harnessSettings = {
    claudePlugins: new ClaudePluginSettingsService(maintenancePorts, commands),
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    plugins: new CodexPluginSettingsService(database.pool, infrastructure?.auxiliary?.plugins ?? new NativeCodexPlugins(() => mainCodex.binary, config.harnesses.workspaceRoot,
      processRegistry.scope('settings:plugins:codex')), () => processRegistry.closeOwner('settings:plugins:codex')),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: infrastructure?.auxiliary?.mcp.codex ?? new CodexMcpConnections(() => mainCodex.binary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
    }, () => { harnessCatalog.invalidateChecks(); nativeConfigurations.invalidateOptions() }, async () => {
      await processRegistry.closeOwner('settings:mcp:codex')
    }, appMcpEndpoint),
  }
  composition.launchScopes = new WeakMap<NativeHarnessSessionManager, NativeProcessRecovery>()
  composition.claudeLaunches = new WeakMap<NativeHarnessSessionManager, ReturnType<typeof productionClaudeManager>>()
}

function configureWorkflowManagers(composition: ProductionComposition) {
  const {
    database,
    infrastructure,
    fileStorageRoot,
    processRegistry,
    access,
    deviceRuntime,
    providerAccounts,
    workflowAccountBindings,
    locations,
    runs,
    remoteWorkflow,
    harnessRegistry,
    nativeFactories,
    selectedProfiles,
    claudeProfiles,
    launchScopes,
    claudeLaunches,
  } = composition
  composition.managers = new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => {
    const configuration = context.configuration.harness
    const acceptedAccount = workflowAccountBindings.get(context.executionId)
    const accountBinding = acceptedAccount?.kind === 'slot' ? acceptedAccount : undefined
    if (configuration.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    const remoteAccount = context.acceptedPlacement?.hostRef.kind === 'device'
      || context.configuration.harnessProfileSelection?.target.hostRef.kind === 'device'
    if (configuration.accountId && remoteAccount) {
      throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY', 'Managed provider accounts cannot run on another computer.', 409)
    }
    // Object allocation remains native/registry IO-free. The coordinator reserves
    // this SAME scope immediately before its lifetime/entered commits.
    const processOwner = context.purpose === 'consultation' && context.consultation
      ? `consultation:${context.consultation.consultationId}` : `execution:${context.executionId}`
    const recovery = processRegistry.scope(processOwner)
    const remote = remoteWorkflow!.manager(context, getOwner)
    if (remote) return remote
    const nativeOutputs = configuration.harness === 'codex' && context.artifactOutputs && !context.purpose
      ? createLocalWorkflowNativeOutputs({ executionId: context.executionId, artifacts: () => {
        if (!composition.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        return composition.localWorkflowArtifacts
      }, stateDirectory: fileStorageRoot, assertCurrent: async signal => {
        signal?.throwIfAborted()
        const owner = getOwner()
        if (!owner || owner.runId !== context.runId) throw new DomainError('RUN_OWNERSHIP_LOST',
          'The local workflow no longer owns its native output turn.', 409)
        owner.assertOwned()
      }, qualification: { registry: processRegistry, qualify: qualifyCodex, command: runCommand } }) : undefined
    const selector = workflowProfileSelection(context,
      remoteWorkflow!.binding(context.executionId)?.executionPlacement?.workingTree.canonicalCwd)
    if (configuration.harness === 'claude') {
      if (!context.runId || !context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
        'Claude requires the persisted Run and execution attempt.', 409)
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(accountBinding ? { accountBinding } : {}),
        profiles: claudeProfiles, ...(selector ? { selector } : {}),
        binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner },
        ...(context.consultation ? { consultation: context.consultation } : {}),
        role: 'workflow', configuration, workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', mode: infrastructure?.mode ?? 'native',
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const owner = getOwner()
          if (!owner) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The workflow native owner is unavailable.', 409)
          const execution = await runs.getExecution(context.executionId, owner), run = await runs.get(context.runId!, owner)
          if (!execution || !run || execution.attempt !== context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The persisted execution attempt changed.', 409)
          const request = HarnessExecutionRequestSchema.parse({ ...context.workflowRequest,
            executionId: execution.id, runId: execution.runId,
            workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
            runtimeDirectory: execution.runtimeDirectory, configuration: context.configuration, input: execution.input })
          return execution.nativeSessionId ? { kind: 'workflow', correlationId: `execution:${execution.id}`, request }
            : { request, correlationId: `execution:${execution.id}` }
        },
      })
      claudeLaunches.set(claude.manager, claude)
      launchScopes.set(claude.manager, recovery)
      return claude.manager
    }
    if (selector) {
      if (!context.runId || !context.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt is unavailable.', 409)
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(accountBinding ? { accountBinding } : {}),
        ...(context.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        selector, binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner,
          ...(context.purpose ? { purpose: context.purpose } : {}),
          ...(context.consultation ? { consultation: context.consultation } : {}) },
        configuration, role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', ...(nativeOutputs ? { nativeOutputs } : {}) })
      launchScopes.set(manager, recovery)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(context.configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...(accountBinding ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? context.agentId, instanceRevision: context.configuration.id, driverId: configuration.harness,
        enabled: true, configuration },
      processRecovery: recovery, appMcpAccess: 'scoped',
      harness: 'codex',
      ...(nativeOutputs ? { nativeOutputs } : {}),
    })
    launchScopes.set(manager, recovery)
    return manager
  })
  composition.validateContinuation = placedContinuationValidator(database.pool, locations, remoteWorkflow, {
    async assertCurrent(binding, signal, purpose) {
      signal?.throwIfAborted()
      const sql = interactionConnection.getStore() ?? database.pool
      if (!composition.agentPlacement) {
        throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      }
      if (binding.placement.hostRef.kind === 'device') {
        const stored = (await sql.query<{ receipt: unknown }>(
          'select receipt from remote_execution_receipts where operation_id=$1',
          [binding.intent.operationId])).rows[0]
        const receipt = stored && RemoteOperationReceiptSchema.parse(stored.receipt)
        if (receipt?.native) {
          // Restart preserves Main's admitted lifetime; it does not authorize a new Worker operation.
          const authenticated = purpose === 'restart' ? receipt.connection
            : deviceRuntime.endpointForDomains().currentBinding(binding.placement.hostRef.deviceId)
          if (!authenticated) {
            throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The authenticated execution connection is unavailable.', 503)
          }
          if (authenticated.bootId !== receipt.connection.bootId) {
            throw new DomainError('REMOTE_NATIVE_OWNER_CLOSED', 'The connected computer restarted during the run.', 409)
          }
          await assertRemoteExecutionAuthority(sql, locations, {
            version: 1, intent: binding.intent, placement: binding.placement, action: 'read',
          }, authenticated, composition.agentPlacement)
          signal?.throwIfAborted()
          return
        }
      }
      const row = (await sql.query<{ principal_id: string; workspace_id: string }>("select record->>'authorizationPrincipalId' as principal_id,workspace_id from runs where id=$1", [binding.intent.runId])).rows[0]
      if (!row) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      const current = await credentialAuthority(sql as GraphSqlClient, binding.intent.executionId, 'workflow')
      await composition.agentPlacement.assertPinsCurrent(sql, binding.placement,
        await readLiveManagementPrincipal(sql, row.principal_id), row.workspace_id,
        current.nativeSessionId ? { purpose: 'resident' } : undefined)
      signal?.throwIfAborted()
    },
  })
  composition.credentials = new WorkerCredentialService(database.pool, access)
  composition.prepareWorkflowManagerContext = async (context: NativeManagerResolutionContext) => {
    const prepared = await remoteWorkflow!.prepareContext(context)
    if (!context.runId) return prepared
    const row = (await database.pool.query<{ version: unknown; node_id: string }>(
      `select v.record as version,e.workflow_node_id as node_id from harness_executions e
       join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
       where e.id=$1 and r.id=$2`, [context.executionId, context.runId])).rows[0]
    if (!row) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The saved native execution is unavailable.', 409)
    const binding = await providerAccounts.runtimeBinding('run-node', context.purpose
      ? `${context.runId}:agent:${context.configuration.agentId}` : `${context.runId}:${row.node_id}`,
    context.configuration.harness, context.configuration.harnessProfileSelection)
    if (binding) workflowAccountBindings.set(context.executionId, binding)
    if (context.purpose) return prepared
    const node = WorkflowVersionV3Schema.parse(row.version).definition.nodes.find(item => item.id === row.node_id)
    return node && node.kind !== 'job' && node.artifactOutputs
      ? { ...prepared, artifactOutputs: node.artifactOutputs } : prepared
  }
}

function configureExecutionCoordinator(composition: ProductionComposition) {
  const {
    config,
    database,
    processRegistry,
    access,
    workflowCapture,
    reviewCapture,
    repository,
    budgets,
    locations,
    runs,
    remoteWorkflow,
    appMcpEndpoint,
    nativeFactories,
    appRoutes,
    launchScopes,
    claudeLaunches,
    managers,
    validateContinuation,
    credentials,
    prepareWorkflowManagerContext,
  } = composition
  const launchCredentials = composition.launchCredentials = {
    async restoreConsultation(binding, environment) {
      const credential = await credentials.restoreForConsultation(binding, environment)
      await appRoutes.refresh()
      return credential
    },
    async renewConsultation(binding, credential, signal) {
      signal?.throwIfAborted()
      const expiresAt = await credentials.renewForConsultation(binding, credential)
      if (!composition.closing) await appRoutes.refresh({ signal })
      return expiresAt
    },
    async restore(executionId, environment) {
      await validateContinuation(executionId)
      const credential = await credentials.restoreForExecution(executionId, environment)
      await appRoutes.refresh()
      return credential
    },
    async recoverRemote(executionId, applicationAccess, job) {
      const execution = await runs.getExecution(executionId)
      const binding = remoteWorkflow.binding(executionId)
      const retained = execution && await readRetainedRemoteReviewer(database.pool, execution)
      if (!execution || !binding || !retained || applicationAccess.executionId !== executionId
        || applicationAccess.operationId !== binding.intent.operationId || applicationAccess.attemptId !== binding.intent.attemptId
        || applicationAccess.bindingHash !== binding.intent.bindingHash || applicationAccess.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential cannot be recovered.', 409)
      if (job) await credentials.bindReviewerJob(executionId, { principalId: retained.principalId }, job)
      const principal = await access.authenticate(applicationAccess.token, 'worker')
      if (principal.id !== retained.principalId || principal.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential changed.', 409)
      return { principalId: principal.id, expiresAt: principal.expiresAt,
        environment: { agentId: execution.agentId, variables: { GRAPHQL_MCP_TOKEN: applicationAccess.token } } }
    },
    async bindReviewerJob(executionId, credential, job, lane) {
      await credentials.bindReviewerJob(executionId, credential, job, lane)
      await appRoutes.refresh()
    },
    async prepare(input) {
      await validateContinuation(input.executionId, input.signal)
      const execution = await runs.getExecution(input.executionId)
      if (!execution || execution.workingDirectory !== input.workingDirectory) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight must use the accepted execution directory.', 409)
      }
      const configuration = await runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      const run = await runs.get(execution.runId)
      if (!configuration || configuration.id !== execution.agentConfigurationVersionId
        || configuration.agentId !== execution.agentId || configuration.harness.harness !== input.harness
        || !run?.executionLocation) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned execution identity.', 409)
      }
      const context = {
        executionId: execution.id, agentId: execution.agentId, harness: input.harness,
        workingDirectory: input.workingDirectory, configuration, runId: execution.runId, attempt: execution.attempt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.consultation ? { consultation: input.consultation } : {}),
      }
      const preparedContext = await prepareWorkflowManagerContext(context)
      const placement = preparedContext.acceptedPlacement
      if (!placement && run.executionLocation.runnerId !== locations.runnerId) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'An unplaced execution requires the local workspace runner.', 409)
      }
      let runnerId = run.executionLocation.runnerId
      if (placement?.hostRef.kind === 'main') runnerId = locations.runnerId
      if (placement?.hostRef.kind === 'device') runnerId = placement.registration!.workerInstallationId
      const manager = input.manager ?? managers.resolve(preparedContext).manager
      const detection = remoteWorkflow.isRemote(input.executionId)
        ? remoteMcpPreflight(manager, preparedContext)
        : new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint)
      if (input.harness === 'claude') {
        const claude = claudeLaunches.get(manager)
        if (!claude || configuration.harness.harness !== 'claude') throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The exact Claude launch is unavailable.', 409)
        return prepareClaudeWorkflowCredentials({ input, configuration: configuration.harness, claude,
          inspector: nativeFactories.inspector(manager), detection, credentials, runnerId, endpoint: appMcpEndpoint,
          refreshRoutes: () => appRoutes.refresh({ signal: input.signal }) })
      }
      const launch = new WorkerLaunchCredentialService(detection, credentials, runnerId)
      // The coordinator reserved and retained this exact manager lifetime
      // BEFORE preflight. It owns disposal + durable closure on every failure;
      // releasing an empty resolver here would destroy the only positive proof.
      const prepared = await launch.prepare(input)
      try { await appRoutes.refresh({ signal: input.signal }) } catch (error) { await credentials.revoke(prepared.credential); throw error }
      return prepared
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (executionId) => credentials.revokeForExecution(executionId),
    revokeForRun: (runId, client) => credentials.revokeForRun(runId, client),
    reconcileTerminalCredentials: () => credentials.reconcileTerminalCredentials(),
    renew: async (executionId, credential, signal) => {
      signal?.throwIfAborted()
      const expiresAt = await credentials.renewForExecution(executionId, credential)
      if (!composition.closing) await appRoutes.refresh({ signal })
      return expiresAt
    },
  }
  composition.approvals = new ApprovalExecutionCoordinator(
    runs, repository, budgets, managers, config.harnesses.timeoutMs, launchCredentials, validateContinuation,
    new PostgresWorkflowClosureStore(database.pool, executionId =>
      processRegistry instanceof NativeProcessRegistry
        && hasNativeRestartDetachment(processRegistry.scope(`execution:${executionId}`))),
    new PostgresRepeatReviewerBindings(database.pool),
    { capture(input) {
      const evidence = workflowCapture.capture.capture(input)
      remoteWorkflow!.capture(input, workflowCapture.verify.read(evidence))
      return evidence
    } }, { capture(input) {
      const evidence = reviewCapture.capture.capture(input)
      remoteWorkflow.captureReview(reviewCapture.verify.read(evidence))
      return evidence
    } },
    async (executionId, signal, owner) => {
      signal.throwIfAborted()
      const placement = await readExecutionPlacement(database.pool, executionId)
      const closed = placement?.hostRef.kind === 'device'
        ? await remoteWorkflow.confirmClosedExecution(executionId, signal, owner)
          || await remoteWorkflowPreparationClosed(database.pool, executionId)
        : await processRegistry.closeOwner(`execution:${executionId}`, signal)
      signal.throwIfAborted()
      return closed
    },
    async (executionId, manager, consultation) => {
      if (remoteWorkflow!.isRemote(executionId)) return
      const scope = launchScopes.get(manager)
      const expectedOwner = consultation ? `consultation:${consultation.consultationId}` : `execution:${executionId}`
      if (!scope || scope.owner !== expectedOwner || scope.launchId) throw new DomainError(
        'NATIVE_LAUNCH_RESERVATION_CONFLICT', 'The exact manager launch scope is unavailable or already reserved.', 409)
      if (hasDetachedStdioProcess(scope)) return
      Object.assign(scope, await processRegistry.reserveLaunch(scope.owner))
    },
    prepareWorkflowManagerContext,
    executionId => remoteWorkflow.afterReviewCommit(executionId),
    composition.workflowCollaboration,
  )
  composition.telemetryLifetime = new AbortController()
  composition.mainTelemetryContext = null
}

function configureConversationManagers(composition: ProductionComposition) {
  const {
    config,
    database,
    checkpoints,
    infrastructure,
    fileStorageRoot,
    responseJournal,
    processRegistry,
    access,
    deviceRuntime,
    providerAccounts,
    accountConfigurations,
    repository,
    budgets,
    locations,
    workflows,
    runs,
    harnessRegistry,
    qualificationRepository,
    selectedSuites,
    nativeFactories,
    selectedProfiles,
    claudeProfiles,
    claudeLaunches,
    launchCredentials,
    approvals,
  } = composition
  const engine = composition.engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository, async runId => {
      await composition.hostCi?.cancelStoppedRun(runId)
    }, {}, (owner, version) => {
      if (!composition.jobRuntime) throw new DomainError('WORKFLOW_JOB_COMPOSITION_REQUIRED', 'The actual Job domain has not initialized.', 503)
      const bound = composition.jobRuntime.workflow.forOwner(owner, version)
      return { store: new PostgresWorkflowJobNodeStore(owner, version, runs.repeatRepositoryFactory().hostForOwner(owner, version),
        bound.locked, workflowJobStorePublication()), driver: bound.driver }
    },
  )
  const interactions = composition.interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction), responseJournal,
    (interaction) => approvals.inspectInteractionActivity(interaction),
  )
  registerApprovalCheckpointResume(interactions, engine)
  const operatorWorkingDirectory = composition.operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = composition.operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const operatorConversations = composition.operatorConversations = new PostgresOperatorConversationRepository(database.pool, accountConfigurations)
  const agentConversations = composition.agentConversations = new PostgresAgentChatRepository(database.pool, providerAccounts.acceptedBindings)
  const workerChats = composition.workerChats = createProductionWorkerConversations({ pool: database.pool,
    endpoint: () => deviceRuntime.endpointForDomains(), profiles: selectedProfiles, claudeProfiles,
    operators: operatorConversations, agents: agentConversations, registry: harnessRegistry,
    qualifications: qualificationRepository, access, mcpForward: () => selectedMainMcpForward(composition.app),
    agentMcp: { authorize: async request => {
      const principal = await access.authenticate(request.token, 'worker')
      const credential = await readConversationCredential(database.pool, principal.id)
      if (!credential) throw new DomainError('ACCESS_DENIED', 'A scoped Agent conversation credential is required.', 403)
      return { subject: credential.subject, expiresAt: principal.expiresAt }
    }, forward: () => selectedMainMcpForward(composition.app) },
    fileService: () => productionFileTools(composition.app),
    files: (conversationId, configuration, workingDirectory) => async ({ host, assertHost, ...turn }) => {
      const admissions = 'operatorId' in configuration
        ? operatorCodexFileAdmissions(() => composition.app, database.pool, configuration, workingDirectory, fileStorageRoot,
          { host, assertCurrent: assertHost })
        : postgresCodexChatFiles(database.pool, () => {
          if (!composition.fileStorage) throw new Error('Production file storage is not registered.')
          return composition.fileStorage
        }, async () => host, { assertCurrent: assertHost })
      return productionCodexChatFiles(() => composition.app, conversationId, admissions).prepare(turn)
    },
    suiteRevisions: selectedSuites ? {
      codex: selectedSuites.codex.revision,
    } : {} })
  composition.agentChatProfileSelection = async (
    configuration: import('@foreman-code/contracts').AgentConfigurationVersion,
    workingDirectory: string, executionId?: string,
  ) => {
    if (!executionId) return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    const source = await runs.getExecution(executionId)
    if (!source || source.agentId !== configuration.agentId
      || source.agentConfigurationVersionId !== configuration.id || source.workingDirectory !== workingDirectory) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source execution changed.', 409)
    }
    const placement = await readExecutionPlacement(database.pool, executionId)
    if (!placement) {
      if (await readAcceptedPlacement(database.pool, source.runId, source.workflowNodeId)) {
        throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source placement is unavailable.', 409)
      }
      return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    }
    const native = await readNativePlacement(database.pool, executionId)
    if (!native) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source working tree is unavailable.', 409)
    }
    const harness = configuration.harness.harness
    if (harness === 'opencode') throw new DomainError('HARNESS_RETIRED', 'OpenCode is retired; this chat source cannot continue.', 409)
    const profileSelection = workflowProfileSelection({ executionId, runId: source.runId, agentId: source.agentId,
      harness, configuration, workingDirectory, acceptedPlacement: placement },
    native?.workingTree.canonicalCwd)
    return { profileSelection, sourceExecution: { executionId, placement, workingTree: native.workingTree } }
  }
  composition.recoverChatCompaction = async (
      configuration: import('@foreman-code/contracts').OperatorConfigurationVersion | import('@foreman-code/contracts').AgentConfigurationVersion,
      conversationId: string, session: import('@foreman-code/contracts').NativeSessionReference,
      start: import('./modules/harnesses/port.js').NativeSessionStart, state: import('@foreman-code/contracts').CompactionState,
      principalId: string, signal: AbortSignal,
      profileSelection = configuration.harnessProfileSelection,
      sourceExecution?: import('@foreman-code/contracts/remote-execution-rpc').WorkerConversationBinding['sourceExecution'],
    ) => {
      if (session.harness === 'opencode' || configuration.harness.harness === 'opencode') {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
      if (profileSelection?.target.hostRef.kind === 'device') {
        const manager = workerChats.create({ configuration, conversationId, workingDirectory: sessionStartDirectory(start),
          appMcpAccess: 'none', lifecycle: 'observer', observationPrincipalId: principalId, profileSelection, sourceExecution })
        try { return await manager.readCompaction!(session, start, state, signal) }
        finally { await manager.dispose?.() }
      }
      if (session.harness === 'claude') return recoverPersistedClaudeCompaction(state)
      const binding: ClaudeProfileOwner = 'operatorId' in configuration
        ? { kind: 'operator', conversationId, repository: operatorConversations, observationPrincipalId: principalId }
        : { kind: 'agent', conversationId, workspaceId: configuration.workspaceId,
          repository: agentConversations, observationPrincipalId: principalId }
      const accepted = profileSelection
        ? await selectedProfiles.admit({ ...binding, admissionSignal: signal }, profileSelection) : undefined
      const selection = accepted ? harnessRegistry.pinOverride(accepted.override)
        : harnessRegistry.pinAccepted({ id: configuration.id,
          agentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
          harness: configuration.harness })
      const common = { selection, configured: selection.instance, role: 'diagnostics' as const,
        accountRecovery: processRegistry.scope('operatorId' in configuration
          ? `conversation:${conversationId}` : `conversation:agent-chat:${conversationId}`),
        workingDirectory: sessionStartDirectory(start),
        ownerAgentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
        appMcpAccess: 'none' as const,
        ...(accepted ? { revalidateSelection: (effectSignal?: AbortSignal) => selectedProfiles.revalidate(
          { ...binding, admissionSignal: effectSignal ?? signal }, accepted) } : {}) }
      const { manager } = nativeFactories.allocate({ ...common, harness: session.harness })
      try {
        await nativeFactories.admitAuxiliary(manager)
        return await manager.readCompaction!(session, start, state, signal)
      } finally { await nativeFactories.disposeAuxiliary(manager) }
    }
  const operatorAccountBindings = composition.operatorAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  composition.resolveOperatorManager = productionOperatorManagers({
    app: () => composition.app, pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    processRegistry, responseJournal, managers: operatorManagers, nativeFactories,
    accountBinding: conversationId => operatorAccountBindings.get(conversationId),
    createDevice: (configuration, conversationId, fileInputs) => workerChats!.create({
      configuration, conversationId, workingDirectory: operatorWorkingDirectory, fileInputs,
      appMcpAccess: fileInputs && configuration.harness.harness === 'claude' ? 'none' : 'scoped' }),
    createSelected: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness === 'opencode') {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
      if (!configuration.harnessProfileSelection || configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The selected Operator driver profile is unavailable.', 409)
      return productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        selector: configuration.harnessProfileSelection, binding: { kind: 'operator', conversationId, repository: operatorConversations },
        configuration: configuration.harness, role: 'operator', workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: 'scoped',
        ...(fileInputs ? { files: productionCodexChatFiles(() => composition.app, conversationId, operatorCodexFileAdmissions(() => composition.app, database.pool,
          configuration, operatorWorkingDirectory, fileStorageRoot)) } : {}),
      }).manager
    },
    createClaude: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude requires the pinned Claude configuration.', 409)
      const controlBinding: Extract<import('./modules/harnesses/claudeSdk/domainAuthority.js').ClaudeDomainBinding, { kind: 'operator' }>
        = { kind: 'operator', conversationId, repository: operatorConversations }
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        profiles: claudeProfiles,
        ...(configuration.harnessProfileSelection ? { selector: configuration.harnessProfileSelection } : {}),
        binding: controlBinding, role: 'operator',
        configuration: configuration.harness, workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: fileInputs ? 'none' : 'scoped', mode: infrastructure?.mode ?? 'native',
        ...(fileInputs ? { files: { service: () => productionFileTools(composition.app), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) } } : {}),
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const row = await operatorConversations.active(conversationId)
          if (!row || !row.active_request_id && !controlBinding.controlPrincipalId
            || row.operator_configuration_version_id !== configuration.id) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The accepted Operator turn is unavailable.', 409)
          return { kind: 'operator', correlationId: nativeCorrelation(conversationId, row.active_request_id ?? 'session-control'), configuration,
            workingDirectory: operatorWorkingDirectory, environment: { agentId: configuration.operatorId, variables: {} } }
        },
      })
      claudeLaunches.set(claude.manager, claude)
      return claude.manager
    },
    selectInstallation: (configuration) => harnessRegistry.initialized
      ? harnessRegistry.pinAccepted({ ...configuration, agentId: configuration.operatorId }) : undefined,
  })
}

function configureOperatorChat(composition: ProductionComposition) {
  const {
    database,
    infrastructure,
    processRegistry,
    access,
    deviceRuntime,
    providerAccounts,
    harnessRegistry,
    operators,
    rollout,
    appMcpEndpoint,
    nativeFactories,
    claudeProfiles,
    harnessInstances,
    claudeLaunches,
    operatorWorkingDirectory,
    operatorConversations,
    workerChats,
    recoverChatCompaction,
    operatorAccountBindings,
    resolveOperatorManager,
  } = composition
  resolveOperatorManager.prepareInput = prepareOperatorChatInput(database.pool, async profile => {
    const host = profile.target.hostRef
    if (host.kind !== 'device') throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The Worker profile is unavailable.', 409)
    const endpoint = deviceRuntime.endpointForDomains()
    const channel = endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
    if (!channel || channel.binding.mainId !== host.mainId
      || channel.binding.workerInstallationId !== profile.target.applicationInstallationId) {
      throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The selected Worker is unavailable.', 503)
    }
    const response = await channel.request({ version: 1, operation: 'workspace-roots.configuration' },
      { signal: new AbortController().signal })
    const roots = ApprovedRootAllowlistSchema.parse(response.payload)
    if (response.bytes !== undefined || !isDeepStrictEqual(roots.hostRef, host)
      || roots.applicationInstallationId !== profile.target.applicationInstallationId
      || !isDeepStrictEqual(endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)?.binding, channel.binding)) {
      throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The selected Worker root changed during input preparation.', 409)
    }
    return roots.managedRuntimeRoot
  })
  const chatAuthority = composition.chatAuthority = new PostgresOperatorChatAuthority(
    database.pool, access, rollout, operatorWorkingDirectory, appMcpEndpoint,
    (manager) => workerChats!.inspector(manager) ?? nativeFactories.inspector(manager),
    async (manager, configuration, environment, signal) => {
      const claude = claudeLaunches.get(manager)
      const servers: ClaudeHarnessConfiguration['mcpServers'] = configuration.harness.harness === 'claude'
        ? configuration.harness.mcpServers : {}
      const serverName = appMcpServerName(servers)
      const configured = servers[serverName]
      const token = readProductEnvironment(environment.variables, 'MCP_TOKEN')
      const worker = workerChats!.deliverClaudeCredential(manager)
      if ((!claude && !worker) || !configured || configured.type !== 'http' || configured.url !== appMcpEndpoint || !token) throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'The accepted Claude HTTP credential arrangement is unavailable.', 409)
      if (worker) await worker(token, signal)
      else if (claude) await claude.manager.refreshInspectionCredentials({ ...await claude.inspectionStart(), environment }, {
          ...(configuration.harness.harness === 'claude' ? configuration.harness.mcpServers : {}),
          [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } },
        }, signal)
      const context = manager.mcpInspectionContext ? await manager.mcpInspectionContext(signal)
        : { runnerId: 'runner-local', workingDirectory: operatorWorkingDirectory }
      const checked = await new McpDetectionService(workerChats!.inspector(manager) ?? nativeFactories.inspector(manager), appMcpEndpoint).preflight({
        harness: 'claude', ...context, signal,
      })
      if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Claude did not acknowledge the scoped Operator credential on its current query.', 409)
    },
    async (principal, configuration, signal) => {
      if (configuration.harness.harness !== 'claude' || !configuration.harnessProfileSelection) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude setup requires its exact saved host profile.', 409)
      const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
        configurationVersionId: configuration.id, configurationHash: configuration.contentHash, admissionSignal: signal }
      const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
      if (accepted.override.target.hostRef.kind === 'device') {
        return inspectWorkerClaudeOperatorConfiguration({ accepted, endpoint: deviceRuntime.endpointForDomains(),
          expectedEndpoint: appMcpEndpoint, signal,
          revalidate: async () => { await claudeProfiles.revalidate(owner, accepted) } })
      }
      const apiKey = await requireClaudeProductionCredentialDelivery(configuration.harness, providerAccounts,
        accepted.override.target.hostRef)
      const binding = harnessRegistry.pinOverride(accepted.override), binary = binding.installation.launcher.resolvedLauncher
      if (!binary) throw new DomainError('HARNESS_HOST_MISMATCH', 'Claude setup must inspect its actual local installed profile.', 409)
      const recovery = await processRegistry.reserveLaunch(`operator-configuration-inspection:${randomUUID()}`)
      const close = async () => {
        await processRegistry.abandonReservedLaunch(recovery)
        if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude read-only configuration inspection closure is unconfirmed.')
      }
      try { return await inspectClaudeOperatorConfiguration({ accepted, binary, workingDirectory: operatorWorkingDirectory,
        ...(apiKey ? { apiKey } : {}),
        endpoint: appMcpEndpoint, recovery, signal, ...(infrastructure?.claudeClient ? {
          loadClient: (profilePath, processRecovery, selectedBinary) => infrastructure.claudeClient!({ profilePath, recovery: processRecovery, binary: selectedBinary }),
        } : {}),
        revalidate: async () => { await claudeProfiles.revalidate(owner, accepted); await nativeFactories.assertInstallationUnchanged(binding, signal) } }) }
      finally { await close() }
    },
  )
  resolveOperatorManager.prepareAccountBinding = async (configuration, conversationId) => {
    const binding = await providerAccounts.runtimeBinding('operator-command', `${conversationId}:session`,
      configuration.harness, configuration.harnessProfileSelection)
    if (binding) operatorAccountBindings.set(conversationId, binding)
    else operatorAccountBindings.delete(conversationId)
  }
  resolveOperatorManager.modelOptions = async configuration =>
    configuration.harness === 'opencode' ? []
      : (await composition.nativeConfigurations.options(configuration.harness)).models
  resolveOperatorManager.qualifiedSteer = qualifiedAgentChatSteer
  resolveOperatorManager.recoverCompaction = recoverChatCompaction
  composition.chat = new OperatorChatService(
    operatorConversations, operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
    async (principal, configuration, commandId) => {
      const selection = await withTransaction(database.pool,
        client => harnessInstances.selectionForConfiguration(principal, configuration, client))
      return selection ?? harnessInstances.prepareOperatorConfiguration(principal, 'http', configuration, commandId)
    },
  )
}

function configureAgentChat(composition: ProductionComposition) {
  const {
    config,
    database,
    infrastructure,
    chatFileAdmissions,
    processRegistry,
    providerAccounts,
    accountConfigurations,
    locations,
    workflows,
    runs,
    harnessRegistry,
    rollout,
    nativeFactories,
    hostSettings,
    selectedProfiles,
    claudeProfiles,
    hostProfileChecks,
    approvals,
    engine,
    agentConversations,
    workerChats,
    agentChatProfileSelection,
    recoverChatCompaction,
  } = composition
  const agentChatManagers = new Map<string, NativeHarnessSessionManager>()
  const nativeAccess = composition.conversationNativeAccess = new ConversationNativeAccess(new ConversationCredentials(database.pool))
  const resolveAgentChatManager: AgentChatManagerFactory = async (conversationId, configuration, workingDirectory, accountSource, featureContext) => {
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const existing = agentChatManagers.get(conversationId)
    if (existing) return existing
    const accountBinding = await providerAccounts.runtimeBinding('agent-conversation', conversationId,
      configuration.harness, configuration.harnessProfileSelection)
    const selected = await agentChatProfileSelection(configuration, workingDirectory, accountSource?.executionId)
    const selector = selected.profileSelection
    const resolved = agentChatManagers.get(conversationId)
    if (resolved) return resolved
    const appMcpAccess = featureContext && conversationChatTools(featureContext).length ? 'scoped' as const : 'none' as const
    if (selector?.target.hostRef.kind === 'device') {
      const manager = workerChats!.create({ configuration, conversationId, workingDirectory, appMcpAccess, fileInputs: true,
        profileSelection: selector, sourceExecution: selected.sourceExecution,
        applicationAccess: start => {
          const token = start.environment?.variables.FOREMAN_CODE_MCP_TOKEN ?? start.environment?.variables.GRAPHQL_MCP_TOKEN
          return token ? { kind: 'agent-chat-mcp', token } : undefined
        } })
      if (featureContext) await nativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    // Chat processes have their own owner scope; they never share a workflow execution's manager.
    const recovery = processRegistry.scope(`conversation:agent-chat:${conversationId}`)
    const sourceRecovery = accountSource
      ? { accountSourceRecovery: processRegistry.scope(`execution:${accountSource.executionId}`) } : {}
    const harness = configuration.harness
    if (harness.harness === 'claude') {
      const { manager } = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        accounts: providerAccounts,
        profiles: claudeProfiles,
        ...(selector ? { selector } : {}),
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        role: 'agent-chat', configuration: harness, workingDirectory, ownerAgentId: configuration.agentId, recovery,
        appMcpAccess, mode: infrastructure?.mode ?? 'native',
        files: { service: () => productionFileTools(composition.app), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) },
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => { throw new DomainError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'Agent chat has no management MCP inspection authority.', 403) },
      })
      if (featureContext) await nativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    if (selector) {
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        selector,
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        configuration: harness, role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId, recovery, appMcpAccess,
        files: productionCodexChatFiles(() => composition.app, conversationId, chatFileAdmissions) })
      if (featureContext) await nativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...sourceRecovery,
      ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? configuration.agentId, instanceRevision: configuration.id, driverId: harness.harness,
        enabled: true, configuration: harness },
      processRecovery: recovery, appMcpAccess,
      harness: 'codex',
      chatFiles: productionCodexChatFiles(() => composition.app, conversationId, chatFileAdmissions),
    })
    if (featureContext) await nativeAccess.bind(manager, featureContext)
    agentChatManagers.set(conversationId, manager)
    return manager
  }
  resolveAgentChatManager.recoverCompaction = async (configuration, conversationId, session, start, state, principalId, signal) => {
    const row = await agentConversations.get(conversationId)
    if (!row || row.agent_configuration_version_id !== configuration.id) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat configuration changed.', 409)
    }
    const executionId = row.record.origin.kind === 'run_execution' && !row.record.sourceConfigurationVersionId
      ? row.record.origin.executionId : undefined
    const selected = await agentChatProfileSelection(configuration, sessionStartDirectory(start), executionId)
    return recoverChatCompaction(configuration, conversationId, session, start, state, principalId, signal,
      selected.profileSelection, selected.sourceExecution)
  }
  resolveAgentChatManager.unavailable = async (configuration, workingDirectory, executionId) => {
    const { profileSelection } = await agentChatProfileSelection(configuration, workingDirectory, executionId)
    if (!profileSelection) return undefined
    const profile = await hostSettings.readAuthorized(client => hostSettings.latest(client, profileSelection.instanceId))
    if (profile && hostProfileChecks.pending(profile)) {
      return { reason: 'harness_unavailable', message: 'This harness profile is being checked. Retry shortly.' }
    }
    if (!profile || !profile.enabled || profile.instanceRevision !== profileSelection.instanceRevision
      || !await harnessRegistry.profileEvidence(profile)) {
      return { reason: 'harness_unavailable', message: 'The harness profile used by this Run is unavailable.' }
    }
    return undefined
  }
  resolveAgentChatManager.prepareInput = prepareAgentChatInput(database.pool)
  resolveAgentChatManager.qualifiedSteer = qualifiedAgentChatSteer
  resolveAgentChatManager.modelOptions = async configuration =>
    configuration.harness === 'opencode' ? []
      : (await composition.nativeConfigurations.options(configuration.harness)).models
  resolveAgentChatManager.release = (conversationId) => { agentChatManagers.delete(conversationId) }
  resolveAgentChatManager.closeRetainedSession = (conversationId, configuration, principalId, signal) =>
    workerChats!.closeRetainedSession(conversationId, configuration, principalId, signal)
  resolveAgentChatManager.closeRecoveredSession = (id, signal) => workerChats!.closeConversation(id, signal)
  composition.agentChat = new AgentChatService(database.pool, agentConversations,
    new PostgresOperatorConversationRepository(database.pool, accountConfigurations), workflows, runs, resolveAgentChatManager, config.harnesses.workspaceRoot)
  composition.reviews = new AutomaticReviewService(database.pool, runs, approvals, locations, rollout,
    async (runId) => {
      // AutomaticReviewService committed the exact review cause and durable Stop
      // intent first. A process restart or failed closure cannot lose that cause.
      // The one engine owns negative settlement and cleanup. No extra terminal
      // writer follows a successful cancel, and uncertainty remains retryable.
      await engine.cancel(runId)
    })
  composition.closing = false
  composition.initialized = false
}

function configureOperatorServices(composition: ProductionComposition) {
  const {
    config,
    database,
    checkpoints,
    createCurrentProduction,
    workerExecution,
    access,
    deviceRuntime,
    commands,
    bugReports,
    providerAccounts,
    accountConfigurations,
    projectRoot,
    locations,
    workflows,
    runs,
    harnessRegistry,
    foundationSettings,
    remoteExecution,
    operators,
    rollout,
    selectedSuites,
    harnessQualifications,
    harnessCompatibility,
    hostSettings,
    selectedProfiles,
    claudeProfiles,
    harnessInstances,
    harnessCatalog,
    managers,
    approvals,
    engine,
    interactions,
    operatorConversations,
    chat,
    agentChat,
  } = composition
  const nativeFactory = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => composition.initialized && !composition.closing,
    reportDispatchFailure: (runId, code, error) => composition.app.log.error({ runId, code, err: error }, 'current workflow dispatch remains unresolved'),
  })
  const productionContext = { primaryPool: database.pool, commands,
    runs, workflows, locations, engine, nativeExecutions: approvals, interactions, checkpointer: checkpoints.saver }
  const binding = (createCurrentProduction ?? nativeFactory)(productionContext)
  if (!isCurrentNativeProductionBinding(binding, productionContext)) throw new DomainError(
    'CURRENT_PRODUCTION_BINDING_REQUIRED', 'Production requires the concrete constructor-bound native lifecycle, not a shape-only publisher.', 503)
  const assertRuntimeOpen = () => {
    if (!composition.initialized || composition.closing) throw new DomainError('CURRENT_RUNTIME_UNAVAILABLE',
      'The native runtime has not acquired ownership or is shutting down.', 503)
  }
  const currentProduction: CurrentRunProductionBinding = Object.freeze({
    startPublication: { ...binding.startPublication, workerExecution, accountBindings: providerAccounts.acceptedBindings,
      ...(selectedSuites ? { placementAdmission: {
      prepare: (...args: Parameters<AgentPlacementProducer['prepare']>) => {
        if (!composition.agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual saved-placement admission producer is unavailable.', 503)
        return composition.agentPlacement.prepare(...args)
      },
    } } : {}) },
    availability: () => composition.initialized && !composition.closing ? binding.availability() : { runtimeAdmission: false, stopAvailable: false },
    assertStartReady: () => { assertRuntimeOpen(); binding.assertStartReady() },
    assertStopReady: () => { assertRuntimeOpen(); binding.assertStopReady() },
    stop: (context: CurrentStopContext) => { assertRuntimeOpen(); return binding.stop(context) },
    reportDispatchFailure: (runId: string, error: unknown) => binding.reportDispatchFailure(runId, error),
  })
  composition.operatorServices = {
    bugReports,
    providerAccounts,
    devices: deviceRuntime.management,
    harnessInstances, harnessRegistry,
    fileRetention: new FileRetentionService(database.pool, commands),
    executionReadiness: new ExecutionReadinessService(rollout, harnessCatalog, async (principal, configurationVersionId) => {
      if (configurationVersionId) await authorizeOperatorConfigurationRead(database.pool,
        await access.currentHarnessInspectionPrincipal(principal.id), configurationVersionId)
      const defaults = configurationVersionId ? undefined : await foundationSettings.getAgentDefaults()
      const configuration = configurationVersionId ? await operatorConversations.configuration(configurationVersionId)
        : await operators.inspectionConfiguration(defaults!.revision)
      if (!configuration || configuration.operatorId !== 'application-operator') throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The saved Operator configuration is unavailable.', 409)
      try {
        if (configuration.harnessProfileSelection) {
          const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
            configurationVersionId: configuration.id, configurationHash: configuration.contentHash }
          if (configuration.harness.harness === 'claude') {
            const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
            requireClaudePolicyQualification(configuration.harness, accepted)
          } else await selectedProfiles.admit(owner, configuration.harnessProfileSelection)
        } else {
          if (configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_REQUIRED', 'The saved Operator Claude configuration has no exact qualified host profile.', 409)
          await harnessCatalog.checkConfiguration(principal, configuration.harness)
        }
      } catch (error) { throw qualificationError(error) }
      return { configurationVersionId: configuration.id, harness: configuration.harness, defaultsRevision: defaults?.revision ?? null }
    }),
    operatorChat: chat,
    agentChat,
    memoryBoards: composition.memoryBoards,
    workspaces: new WorkspaceManagementService(database.pool, commands, locations, foundationSettings, projectRoot),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands, {
      agentActiveTimeoutMs: config.harnesses.timeoutMs,
      accountConfigurations,
      worktrees: {
        readyRoot: (principal, workspaceId, sql) => {
          if (!composition.runtimeServices.workspaceRepositories) return Promise.resolve(undefined)
          return composition.runtimeServices.workspaceRepositories.readyRoot(principal, workspaceId, sql)
        },
        sources: {
          resolveRootBinding: (...args) => {
            if (!composition.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return composition.jobRuntime.sources.resolveRootBinding(...args)
          },
          resolveApprovedSource: (...args) => {
            if (!composition.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return composition.jobRuntime.sources.resolveApprovedSource(...args)
          },
        },
        roots: {
          resolve: (...args) => {
            if (!composition.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Root services are not initialized.', 503)
            return composition.jobRuntime.policies.resolve(...args)
          },
        },
      },
    }),
    agents: new AgentManagementService(database.pool),
    harnesses: harnessCatalog,
    harnessCompatibility,
    ...(harnessQualifications ? { harnessQualifications } : {}),
    remoteExecution,
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators, harnessInstances, accountConfigurations),
    workerExecution,
    runs: new RunManagementService(database.pool, commands, runs, engine, locations, currentProduction, async (executionId, session, cursor, signal) => {
      const owned = managers.residentForRead(executionId)
      if (!owned?.manager.subagentHistory || owned.context.harness !== session.harness) throw new DomainError('SUBAGENT_HISTORY_UNAVAILABLE', 'The original admitted parent history owner is unavailable.', 409)
      owned.assertCurrent()
      const page = await owned.manager.subagentHistory(session, cursor, signal)
      owned.assertCurrent()
      return page
    }, productionSubagentControls(managers)),
    commands,
    interactions: new OperatorInteractionService(interactions),
    // Reads and lifecycle mutations share the same canonical V3 journal.
    runGraph: new RunGraphReadService(database.pool, { qualifiedReads: true }),
    runPlacements: new RunPlacementReadService(database.pool, readRemoteObservations),
    placementChoices: new NodePlacementChoicesService(database.pool, new ProductionPlacementChoiceDiscovery(
      database.pool, () => {
        if (!composition.jobRuntime) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Computer choices are not initialized.', 503)
        const runtime = composition.jobRuntime
        return { roots: runtime.policies, sources: runtime.sources, profiles: hostSettings, registry: harnessRegistry,
          ensureProfileReady: profile => composition.harnessInstances.ensureReady(profile),
          ensureComputerReady: async host => {
            workerExecution.requireEnabled(host)
            if (host.kind === 'device') await deviceRuntime.endpointForDomains().assertWorkerBundleReady(host.deviceId)
          },
          provisionRoot: (...args: Parameters<ProductionCiEnrollmentInventory['root']>) => {
            const workspaceRoots = composition.runtimeServices.workspaceRoots
            if (!workspaceRoots) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Workspace roots are not initialized.', 503)
            const inventory = new ProductionCiEnrollmentInventory(database.pool, runtime.sources,
              () => deviceRuntime.endpointForDomains(), () => runtime.mainCiRuntime, workerExecution,
              new ManagedWorkspaceRootService(commands, workspaceRoots, runtime.policies))
            return inventory.root(...args)
          },
        }
      },
    )),
  }
  composition.operatorServices.workflowHierarchy = new WorkflowHierarchyService(database.pool, commands,
    composition.operatorServices.workflows)
  const executionChat = createWorkflowExecutionChatService(database.pool, approvals)
  composition.operatorServices.executionChat = executionChat
  composition.workflowChat = createProductionWorkflowChat({ pool: database.pool,
    agent: composition.agentChat, agentRepository: composition.agentConversations, operator: composition.chat,
    execution: executionChat,
    bindConversationScope: composition.conversationNativeAccess.rebind,
  })
  composition.operatorServices.browser = composition.browser
  composition.operatorServices.workflowChat = composition.workflowChat.service
  composition.operatorServices.chatDelivery = composition.workflowChat.router
}

function configureHttpApplication(composition: ProductionComposition) {
  const {
    config,
    database,
    checkpoints,
    logger,
    infrastructure,
    access,
    commands,
    bugReports,
    providerAccounts,
    accountConfigurations,
    repository,
    projectRoot,
    locations,
    workflows,
    runs,
    workspaces,
    appMcpEndpoint,
    nativeFactories,
    harnessInstances,
    harnessCatalog,
    nativeConfigurations,
    harnessSettings,
    engine,
    interactions,
    chat,
    operatorServices,
  } = composition
  const detection = new McpDetectionService({
    async inspect(input) {
      if (input.runnerId !== 'runner-local') {
        throw new DomainError('RUNNER_UNSUPPORTED', 'This API can inspect only its local runner.', 409)
      }
      // Diagnostics allocate their own credential-free child, never a workflow manager.
      if (input.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude diagnostics require an explicit accepted profile owner.', 409)
      const { manager, inspector } = nativeFactories.allocate({
        harness: input.harness, role: 'diagnostics', workingDirectory: input.workingDirectory,
        ownerAgentId: 'mcp-inspection', appMcpAccess: 'none',
      })
      try { return await inspector.inspect(input) } finally { await nativeFactories.disposeAuxiliary(manager) }
    },
  }, appMcpEndpoint)
  const operatorExtensions = createOperatorExtensions({
    pool: database.pool, commands, catalog: harnessCatalog, native: nativeConfigurations,
    detection, locations, workflows: operatorServices.workflows.current,
    provisioningRoot: projectRoot, harnessProfiles: harnessInstances,
    accountConfigurations,
  })
  const runtimeServices = composition.runtimeServices = { ...operatorServices, extensions: operatorExtensions, harnessSettings }
  const localHuman = new PostgresLocalHumanAccess(database.pool, access)
  interactions.useWorkDirectionActions({
    start: (principal, source, input, options) => operatorServices.runs.start(principal, source, input, options),
    wake: () => engine.reconcile(),
  })
  const runtimeBuildIdentity = readRuntimeBuildIdentity()
  const app = composition.app = buildApp({
    runtimeBuildIdentity: () => runtimeBuildIdentity,
    ...(infrastructure?.closeInfrastructure ? { closeInfrastructure: infrastructure.closeInfrastructure } : {}),
    runtimeIdentity: async () => {
      const identity = await readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)
      const testResourcesId = readTestResourcesIdentity(config)
      return { ...identity, ...(testResourcesId ? { testResourcesId } : {}) }
    },
    localHuman,
    ...(config.browserOrigin ? { browserOrigin: config.browserOrigin } : {}),
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, engine, interactions, chat },
    operator: { access, services: runtimeServices },
    appMcp: { access, commands, bugReports, interactions: Object.assign(new PostgresAppInteractionService(database.pool, repository, commands, interactions), {
      syncedFolder: (workspaceId: string, hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }) =>
        runtimeServices.computerSync?.sharedFolder(workspaceId, hostRef) ?? Promise.resolve(null) }) },
    workerArtifacts: () => composition.workflowArtifacts?.extension,
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  app.addHook('onClose', () => providerAccounts.close())
  registerFileRetentionRoutes(app, operatorServices.fileRetention)
}

function configureRuntimeLifecycle(composition: ProductionComposition) {
  const {
    config,
    database,
    fileStorageRoot,
    access,
    entrypoint,
    rsync,
    deviceRuntime,
    commands,
    harnessRegistry,
    harnessQualifications,
    harnessCompatibility,
    nativeFactories,
    harnessInstances,
    installationMonitor,
    harnessCatalog,
    nativeConfigurations,
    appRoutes,
    harnessSettings,
    managers,
    approvals,
    telemetryLifetime,
    engine,
    operatorManagers,
    workerChats,
    chat,
    agentChat,
    reviews,
    runtimeServices,
    app,
  } = composition
  composition.mountArtifacts = () => {
    if (composition.workflowArtifacts || !composition.fileStorage || !composition.artifactComposition) return
    composition.workflowPhysicalArtifacts = new PostgresWorkflowPhysicalArtifacts(composition.artifactComposition.mainId,
      { authority: composition.artifactComposition.authority, files: composition.fileStorage.repository })
    composition.workflowArtifacts = mountProductionWorkflowArtifacts({ app, pool: database.pool, files: composition.fileStorage,
      ...composition.artifactComposition, attempts: composition.artifactComposition.fence, commands, access,
      endpoint: deviceRuntime.endpointForDomains(), stagingRoot: resolve(fileStorageRoot, 'workflow-artifact-transfers') })
  }
  composition.httpClosing = false
  const startupLifetime = composition.startupLifetime = new AbortController()
  composition.stopComputerTimers = () => {}
  composition.stopSyncTimer = () => {}
  const runtimeOwner = composition.runtimeOwner = new OperatorRuntimeOwner(config.database.connectionString, (error) => {
    app.log.error({ err: error }, 'native runtime ownership lost; stopping execution')
    beginShutdown()
    // Never re-enter/await app.close() from an onClose cleanup. The failed
    // connection has already lost its lock; native recovery fencing still applies.
    if (!composition.httpClosing) void composition.shutdown().catch((failure: unknown) => {
      app.log.error({ err: failure }, 'shutdown after native runtime ownership loss failed')
    })
  })
  const lifecycle = composition.lifecycle = new RuntimeShutdown({
    stop: [
      { name: 'shared file sync admission', run: () => {
        composition.stopSyncTimer()
        runtimeServices.computerSync?.stopAdmission()
      } },
      { name: 'computer maintenance admission', run: () => {
        composition.stopComputerTimers()
        composition.browser.stopAdmission()
        runtimeServices.computerMaintenance?.stopAdmission()
      } },
      { name: 'passive resource telemetry admission', run: async () => { telemetryLifetime.abort() } },
      { name: 'device admission', run: () => deviceRuntime.stopAdmission() },
      { name: 'original rsync byte ownership', run: () => rsync.kind === 'configured' ? rsync.rsyncWriters.close() : undefined },
      { name: 'canonical harness inventory and profile checks', run: async () => {
        const inventoryClose = installationMonitor.close()
        harnessRegistry.stop()
        await Promise.all([inventoryClose, harnessInstances.closeChecks()])
      } },
      { name: 'diagnostic and configuration qualification admission', run: async () => { nativeFactories.stopAuxiliaries() } },
      { name: 'live harness qualification admission', run: async () => { harnessQualifications?.stop() } },
      { name: 'harness compatibility diagnostics', run: () => harnessCompatibility.close() },
      { name: 'native MCP settings', run: () => harnessSettings.mcp.shutdown() },
      { name: 'Codex plugin settings', run: () => harnessSettings.plugins.shutdown() },
      { name: 'harness qualification checks', run: () => Promise.all([harnessCatalog.shutdownChecks(), nativeConfigurations.shutdownChecks()]).then(() => undefined) },
      { name: 'browser runtime', run: async () => { await composition.browser.stop(); composition.browserRemote.close() } },
      { name: 'Group chat', run: async () => { composition.stopWorkflowChat?.() } },
      { name: 'Operator chat', run: () => chat.shutdown() },
      { name: 'Agent chat', run: () => agentChat.shutdown() },
      { name: 'automatic reviews', run: () => reviews.shutdown() },
      { name: 'workflow engine', run: () => engine.shutdown() },
    ],
    drain: [
      { name: 'startup schema preparation', run: () => composition.schemaPreparation?.then(() => undefined, () => undefined) },
      { name: 'shared file sync work', run: () => runtimeServices.computerSync?.join() },
      { name: 'live harness qualification', run: () => harnessQualifications?.join() },
      // Initialization errors belong to initialize()'s caller, not to cleanup.
      // Wait for its last DB/filesystem operation even if startup was canceled.
      { name: 'initialization', run: () => composition.initialization?.then(() => undefined, () => undefined) },
      { name: 'native defaults initialization', run: () => composition.nativeDefaultsInitialization?.then(() => undefined, () => undefined) },
      { name: 'reconciliation', run: () => composition.reconciliation },
      { name: 'source reservation reclamation', run: () => composition.jobRuntime?.drainMaterializationReservationReconciliation() },
    ],
    dispose: [
      { name: 'computer maintenance tasks', run: () => runtimeServices.computerMaintenance?.drain() },
      { name: 'worker conversation callback admissions', run: async () => { await workerChats?.close() } },
      { name: 'installed rsync canonical receiver', run: () => entrypoint ? entrypoint.close() : undefined },
      { name: 'workflow artifact byte receiver', run: async () => { await composition.workflowArtifacts?.receiver.close() } },
      { name: 'passive resource telemetry collector', run: async () => { await composition.telemetry?.close() } },
      { name: 'diagnostic and configuration qualification native managers', run: () => nativeFactories.disposeAuxiliaries() },
      { name: 'Job dispatch owners', run: async () => { await composition.jobRuntime?.close() } },
      { name: 'execution native managers', run: async () => {
        // Preserve the manager and authenticated channels until every restart detach commits, including retries.
        try {
          await approvals.closeForRestart()
          await managers.dispose()
          await deviceRuntime.drain()
        } catch (error) {
          throw new AggregateError([error], 'Execution native manager disposal was incomplete.', { cause: error })
        }
      } },
      { name: 'remaining Operator native managers', run: async () => {
        // Snapshot only after all producers have drained. Keep failed disposals
        // visible instead of clearing their ownership records unconditionally.
        const results = await Promise.allSettled([...operatorManagers.entries()].map(async ([id, manager]) => {
          const disposable = manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
          if (!disposable.dispose) throw new Error('An owned native manager has no disposal contract.')
          await disposable.dispose()
          if (operatorManagers.get(id) === manager) operatorManagers.delete(id)
        }))
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Operator native manager disposal was incomplete.')
      } },
    ],
    // Independent of initialized: startup can acquire ownership and then fail.
    releaseOwnership: async () => {
      await appRoutes.close()
      await runtimeOwner.close()
    },
  })
  const beginShutdown = composition.beginShutdown = (): void => {
    composition.closing = true
    appRoutes.stopAdmission()
    startupLifetime.abort()
    lifecycle.begin()
  }
  const assertOpen = composition.assertOpen = (): void => {
    if (composition.closing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503)
  }
  composition.startupDatabase = <T>(work: () => Promise<T>): Promise<T> =>
    retryStartupDatabase(work, { signal: startupLifetime.signal, check: assertOpen })
}

function configureRuntimeStartup(composition: ProductionComposition) {
  const {
    config,
    database,
    checkpoints,
    infrastructure,
    deviceRuntime,
    providerAccounts,
    harnessRegistry,
    foundationSettings,
    operators,
    appMcpEndpoint,
    nativeConfigurations,
    app,
    startupLifetime,
    runtimeOwner,
    assertOpen,
    startupDatabase,
  } = composition
  const synchronizeOperatorDefaults = composition.synchronizeOperatorDefaults = async (
    template: AgentDefaults['operator'],
  ): Promise<void> => {
    await withTransaction(database.pool, async client => {
      const current = await operators.ensureWithClient(client)
      if (isDeepStrictEqual(current.configuration.harness, template.harness)
        && isDeepStrictEqual(current.configuration.nativeTools, template.nativeTools)) return
      await operators.updateWithClient(
        client, template.harness, current.operator.currentConfigurationVersionId,
        template.showThinking ?? false, template.assignedSkills, template.harnessProfileSelection ?? null,
        template.nativeTools ?? null,
      )
    })
  }
  composition.prepareSchema = (): Promise<void> => {
    if (composition.closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    composition.schemaPreparation ??= Promise.resolve().then(async () => {
      await runtimeOwner.acquire()
      assertOpen()
      await startupDatabase(() => database.migrate())
      assertOpen()
      await startupDatabase(() => checkpoints.setup())
      assertOpen()
    })
    return composition.schemaPreparation
  }
  composition.initialize = (): Promise<void> => {
    if (composition.closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    if (composition.initialized) return Promise.resolve()
    // Coalesce startup and publish its lifetime before starting any async work.
    composition.initialization ??= Promise.resolve().then(async () => {
      await initializeRuntimeOwner(composition)
      const machine = await deviceRuntime.initializeFromRuntime(() => startupDatabase(() => readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)))
      providerAccounts.bindTarget(async () => ({ hostRef: { kind: 'main', mainId: machine.installationId },
        applicationInstallationId: machine.installationId, keyRevision: null, authorizationRevision: null }))
      assertOpen()
      await composition.browser.start(machine.installationId)
      await initializeJobServices(composition, machine)
      await initializeWorkflowArtifacts(composition, machine)
      const computerServices = await initializeComputerServices(composition, machine)
      await initializeCiServices(composition, machine, computerServices)
      await initializeHarnessServices(composition, machine)
    })
    // On failure the startup caller closes the app. Only the shared shutdown
    // barrier may release the owner, after any already-admitted work drains.
    return composition.initialization
  }
  app.addHook('onListen', async () => {
    composition.stopWorkflowChat ??= composition.workflowChat.start()
    if (!composition.initialized || composition.closing || infrastructure?.mode === 'replay') return
    composition.nativeDefaultsInitialization ??= (async () => {
      await initializeNativeDefaults({
        pool: database.pool,
        options: harness => startupDatabase(() => nativeConfigurations.options(harness)),
        appMcpEndpoint,
        signal: startupLifetime.signal,
      })
      assertOpen()
      await startupDatabase(() => harnessRegistry.refreshMain())
      assertOpen()
      const initializedDefaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
      const currentOperator = await startupDatabase(() => operators.ensure())
      if (!isDeepStrictEqual(currentOperator.configuration.harness, initializedDefaults.value.operator.harness)) {
        await startupDatabase(() => synchronizeOperatorDefaults(initializedDefaults.value.operator))
      }
    })()
    await composition.nativeDefaultsInitialization
  })
}

function configureRuntimeHooks(composition: ProductionComposition) {
  const {
    config,
    database,
    bugReports,
    runWorktrees,
    appRoutes,
    engine,
    interactions,
    chat,
    reviews,
    app,
    lifecycle,
    beginShutdown,
  } = composition
  const SNAPSHOT_RELEASE_INTERVAL_MS = 10 * 60_000
  let lastSnapshotRelease = 0
  const commandReceiptRetention = new PostgresCommandReceiptRetention(database.pool)
  let lastReceiptCleanup = 0
  composition.reconcile = (report: (error: unknown) => void): Promise<void> => {
    if (composition.closing) return Promise.resolve()
    if (composition.reconciliation) return composition.reconciliation
    composition.reconciliation = trackService('run-reconciliation', { cadenceMs: 5_000, deadlineMs: 10 * 60_000 }, async () => {
      await bugReports.detectStuckExecutions(config.stuckExecutionIdleMs ?? DEFAULT_STUCK_EXECUTION_IDLE_MS)
      if (composition.jobRuntime) await composition.jobRuntime.reconcileFailedCaptures(report)
      composition.jobRuntime?.startMaterializationReservationReconciliation(report)
      if (composition.jobRuntime) await closeCompletedWorkflowSources(database.pool, composition.jobRuntime.sources, report)
      // Age-based release is not urgent; storage pressure still releases on demand during approval and preparation.
      if (composition.jobRuntime && Date.now() - lastSnapshotRelease >= SNAPSHOT_RELEASE_INTERVAL_MS) {
        lastSnapshotRelease = Date.now()
        await composition.jobRuntime.sources.releaseUnusedSnapshots(report)
      }
      await engine.reconcile(report)
      if (composition.closing) return
      await runWorktrees.cleanup(report)
      if (composition.closing) return
      if (Date.now() - lastReceiptCleanup >= SNAPSHOT_RELEASE_INTERVAL_MS) {
        lastReceiptCleanup = Date.now()
        try { await commandReceiptRetention.prune() } catch (error) { report(error) }
      }
      if (composition.initialized) {
        await appRoutes.refresh()
        if (composition.closing) return
        await chat.reconcileActive()
        if (composition.closing) return
        await reviews.tick()
      }
      let afterId: string | undefined
      do {
        if (composition.closing) return
        const page = await interactions.recover({ limit: 100, ...(afterId ? { afterId } : {}) })
        for (const failure of page.errors) report(new Error(`Interaction ${failure.interactionId}: ${failure.error}`))
        afterId = page.nextCursor ?? undefined
      } while (afterId)
    }).finally(() => { composition.reconciliation = undefined })
    return composition.reconciliation
  }
  app.addHook('preClose', async () => {
    composition.httpClosing = true
    beginShutdown()
    // Signal now, but do not release ownership before in-flight HTTP handlers
    // have drained. They may still finish native/DB lifecycle operations.
  })
  const drainShutdown = composition.drainShutdown = (): Promise<void> => {
    composition.httpClosing = true
    beginShutdown()
    return lifecycle.finish()
  }
  app.addHook('onClose', async () => { await drainShutdown() })
  composition.shutdown = (): Promise<void> => {
    beginShutdown()
    // External callers close HTTP first. Repeated calls share app.close(), and
    // cannot release ownership while HTTP is draining in preClose.
    // onClose hooks must use drainShutdown(), not await this enclosing close.
    composition.applicationClose ??= Promise.resolve().then(() => app.close())
    return composition.applicationClose
  }
}

async function initializeRuntimeOwner(composition: ProductionComposition) {
  const {
    mainCodex,
    entrypoint,
    foundationSettings,
    remoteExecution,
    operators,
    appRoutes,
    harnessSettings,
    operatorWorkingDirectory,
    chatAuthority,
    operatorServices,
    runtimeOwner,
    assertOpen,
    startupDatabase,
    synchronizeOperatorDefaults,
    config,
    infrastructure,
  } = composition

  assertOpen()
  await runtimeOwner.acquire()
  assertOpen()
  await startupDatabase(() => remoteExecution.initialize())
  await entrypoint?.recover()
  assertOpen()
  if (infrastructure?.mode !== 'replay') await mainCodex.initialize()
  assertOpen()
  const canonicalDirectory = await ensureOperatorRuntimeDirectory(config.harnesses.workspaceRoot)
  assertOpen()
  if (canonicalDirectory !== operatorWorkingDirectory) {
    throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The canonical Operator directory differs from the configured managed path.', 422)
  }
  const operator = await startupDatabase(() => operators.ensure())
  assertOpen()
  const defaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
  assertOpen()
  if (!isDeepStrictEqual(operator.configuration.harness, defaults.value.operator.harness)
    || !isDeepStrictEqual(operator.configuration.nativeTools, defaults.value.operator.nativeTools)) {
    await startupDatabase(() => synchronizeOperatorDefaults(defaults.value.operator))
    assertOpen()
  }
  await startupDatabase(() => chatAuthority.revokeOrphanedCredentials())
  await startupDatabase(() => appRoutes.refresh())
  assertOpen()
  await startupDatabase(() => harnessSettings.mcp.recover())
  assertOpen()
  await startupDatabase(() => operatorServices.runs.recoverSubagentCommands())
  assertOpen()
  await startupDatabase(() => harnessSettings.plugins.recover())
  assertOpen()

}

async function initializeJobServices(composition: ProductionComposition, machine: ProductionMainInstallation) {
  const {
    workerExecution,
    fileStorageRoot,
    processRegistry,
    inputAcknowledgements,
    installedRsync,
    rsync,
    deviceRuntime,
    commands,
    locations,
    approvals,
    runtimeServices,
    app,
    config,
    database,
    infrastructure,
  } = composition

  composition.trustedConnections = new PostgresTrustedConnectionSetup(database.pool, machine.installationId)
  runtimeServices.trustedConnections = composition.trustedConnections
  registerTrustedConnectionRoutes(app, composition.trustedConnections,
    async request => request.reauthorizeOperator ? request.reauthorizeOperator() : requirePrincipal(request))
  const activeNativeSession: SourceActiveNativeSessionReader = (sql, record) =>
    readSourceCurrentNativeSession(sql, record, approvals.passiveOwnedNativeSessions())
  const captureNativeSession: SourceNativeSessionCaptureReader = async record => {
    const captures = approvals.passiveOwnedNativeSessions()
    const readCurrent = async () => {
      return withTransaction(database.pool, async (sql) => {
        const proof = await readSourceCurrentNativeSession(sql, record, captures)
        return proof
      })
    }
    let proof = await readCurrent()
    if (!proof) return null
    const capture = captures.find(value => value.execution.id === record.receipt.executionId)!
    return { get proof() { return proof! }, signal: capture.signal, async assertCurrent() {
      capture.signal.throwIfAborted(); capture.assertCurrent()
      const current = await readCurrent()
      if (!sourceNativeSessionContinues(proof, current)) throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original entered native owner or source lane is no longer current.', 409)
      proof = current
      capture.signal.throwIfAborted(); capture.assertCurrent()
    } }
  }
  composition.jobRuntime = await createProductionJobs({ pool: database.pool, commands, locations, mainId: machine.installationId,
    availableMemory: async profile => {
      const fingerprint = profile.measurement?.fingerprint
      if (!composition.telemetry || !fingerprint) return null
      const registration = profile.root.registration
      return composition.telemetry.service.availableComputerMemory({ hostRef: profile.root.selection.hostRef,
        applicationInstallationId: registration?.workerInstallationId ?? fingerprint.mainInstallationId,
        bootId: fingerprint.bootId, keyRevision: registration?.keyRevision ?? null,
        authorizationRevision: registration?.authorizationRevision ?? null }, AbortSignal.timeout(5000))
    },
    workerExecution,
    runtimeRoot: config.harnesses.workspaceRoot, storageRoot: fileStorageRoot, endpoint: () => deviceRuntime.endpointForDomains(),
    activeNativeSession, captureNativeSession,
    ...(installedRsync ? { transferReceiver:installedRsync.receiver,
      transferPreparationClosed: async closure => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
        await rsync.backend.retirePreparation(closure, AbortSignal.timeout(15_000))
      },
      transferMaterializationClosed: async record => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
        await rsync.backend.retireMaterialization(record, AbortSignal.timeout(15_000))
      },
      outputRsync:{stage:async(intent,signal)=>{
        if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
        return rsync.backend.send(intent,undefined,signal)
      },acknowledge:async(intent,signal)=>{
        if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
        await rsync.backend.acknowledge(intent,signal)
      }},
      inputRsync: { stage: async (intent, source, signal) => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        return rsync.backend.send(intent, source, signal)
      }, acknowledge: async (intent, signal) => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        if (inputAcknowledgements.has(intent.transferId)) throw new DomainError('JOB_INPUT_ACK_BUSY', 'Original input delivery ACK is already coordinating.', 409)
        inputAcknowledgements.set(intent.transferId, structuredClone(intent))
        try { await rsync.backend.acknowledge(intent, signal) } finally { inputAcknowledgements.delete(intent.transferId) }
      } },
      transferAcknowledged: async intent => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        await rsync.backend.acknowledge(intent)
      } } : {}),
    ...(processRegistry instanceof NativeProcessRegistry ? { nativeRegistry: processRegistry } : {}),
    ...(infrastructure?.jobs ? { infrastructure: infrastructure.jobs } : {}) })

}

async function initializeWorkflowArtifacts(composition: ProductionComposition, machine: ProductionMainInstallation) {
  const {
    workerExecution,
    access,
    deviceRuntime,
    providerAccounts,
    workflowCapture,
    locations,
    remoteWorkflow,
    harnessRegistry,
    selectedSuites,
    harnessInstances,
    installationMonitor,
    app,
    mountArtifacts,
    database,
    infrastructure,
  } = composition
  const jobRuntime = composition.jobRuntime!

  if (selectedSuites) {
    composition.agentPlacement = new AgentPlacementProducer(database.pool, machine.installationId, jobRuntime.sources, jobRuntime.policies,
      harnessRegistry, { codex: selectedSuites.codex.revision },
      workerExecution, profile => harnessInstances.ensureReady(profile),
      (hosts, signal) => installationMonitor.refreshHosts(hosts, signal), providerAccounts, async host => {
        if (host.kind === 'device') await deviceRuntime.endpointForDomains().assertWorkerBundleReady(host.deviceId)
      })
    composition.agentPreparation = new AgentExecutionPreparation(jobRuntime.sources, composition.agentPlacement)
    composition.executionAuthority = createExecutionAuthorityExtension(database.pool, locations, composition.agentPlacement)
  }
  const artifactPorts: NativeArtifactAuthorityPorts = { locations,
    producer: { assertPinsCurrent: (...args) => {
      if (!composition.agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual artifact placement producer is unavailable.', 503)
      return composition.agentPlacement.assertPinsCurrent(...args)
    } } }
  const artifactAuthority = new PostgresArtifactPublicationAuthority(machine.installationId, database.pool, artifactPorts)
  composition.localWorkflowArtifacts = new LocalWorkflowArtifacts(database.pool,
    new LocalWorkflowArtifactAuthority(machine.installationId, database.pool, locations, artifactPorts.producer), () => {
      if (!composition.fileStorage) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
        'Local workflow artifact storage is unavailable.', 503)
      return composition.fileStorage
    })
  const outputAuthorization = infrastructure?.nativeOutputAuthorization?.(artifactAuthority)
    ?? createWorkerNativeOutputAuthorizationPort(artifactAuthority, async (input, connection, sql) => {
      const binding = deviceRuntime.currentBinding(connection.deviceId)
      const identity = binding && DeviceConnectionIdentitySchema.parse({ mainId: binding.mainId,
        deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
        authorizationRevision: binding.authorizationRevision, bootId: binding.bootId,
        connectionGeneration: binding.connectionGeneration })
      const original = DeviceConnectionIdentitySchema.parse({ mainId: connection.mainId, deviceId: connection.deviceId,
        workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision,
        authorizationRevision: connection.authorizationRevision, bootId: connection.bootId,
        connectionGeneration: connection.connectionGeneration })
      if (!binding || !isDeepStrictEqual(identity, original)) {
        throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original artifact connection changed.', 403)
      }
      const row = (await sql.query<{ workspace_id: string; workflow_id: string }>(
        'select workspace_id,workflow_id from runs where id=$1 for share', [input.intent.runId])).rows[0]
      if (!row) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original artifact Run is unavailable.', 409)
      return artifactAuthority.resolveWorkflowContext({ workspaceId: row.workspace_id, workflowId: row.workflow_id,
        runId: input.intent.runId, nodeId: input.intent.nodeId, executionId: input.intent.executionId,
        attemptId: input.intent.attemptId, placementHash: input.intent.bindingHash }, transferContextForBinding(binding), sql)
    })
  composition.mainWorkerMcp = new MainWorkerMcpRelay(machine.installationId, database.pool, access, selectedMainMcpForward(app), outputAuthorization)
  composition.artifactOutputsGate = createWorkflowArtifactOutputsGate(machine.installationId, artifactAuthority)
  composition.artifactResultSource = createProductionWorkflowArtifactResultSource({ captures: workflowCapture.verify,
    physical: remoteWorkflow, authority: artifactAuthority })
  composition.admitWorkflowFileContext = createProductionWorkflowFileContexts(machine.installationId, { captures: workflowCapture.verify,
    assertPhysical: remoteWorkflow.assertPhysical, authority: artifactAuthority, transferContext: remoteWorkflow.fileTransferContext })
  composition.artifactComposition = { mainId: machine.installationId, authority: artifactAuthority,
    fence: new PostgresAcceptedArtifactAttemptFence(machine.installationId, artifactPorts) }
  mountArtifacts()

}

async function initializeComputerServices(composition: ProductionComposition, machine: ProductionMainInstallation) {
  const {
    mainCodex,
    deviceRuntime,
    commands,
    projectRoot,
    locations,
    maintenancePorts,
    harnessSettings,
    runtimeServices,
    app,
    runtimeOwner,
    assertOpen,
    startupDatabase,
    config,
    database,
  } = composition
  const jobRuntime = composition.jobRuntime!

  await startupDatabase(() => bootstrapLocalMainWorkspaceRoot({ pool: database.pool, policies: jobRuntime!.policies,
    mainId: machine.installationId, runtimeRoot: config.harnesses.workspaceRoot, appStorageRoot: projectRoot }))
  const workspaceRoots = runtimeServices.workspaceRoots = new WorkspaceBoundLocationService(
    database.pool, commands, jobRuntime.policies,
  )
  locations.setRootPolicies(jobRuntime.policies)
  registerWorkspaceRootRoutes(app, runtimeServices.workspaceRoots)
  runtimeServices.sources = jobRuntime.sources
  runtimeServices.workspaceRepositories = new WorkspaceRepositoryService(database.pool, commands,
    runtimeServices.workspaces, runtimeServices.workspaceRoots, jobRuntime.policies, jobRuntime.sources,
    machine.installationId, projectRoot)
  registerWorkspaceRepositoryRoutes(app, runtimeServices.workspaceRepositories)
  const { clouds, discoverClouds, circleCredits, circleStandby } = await initializeCircleCi(composition, machine)
  runtimeServices.computerActivity = new ComputerActivityService(database.pool, machine.installationId,
    id => deviceRuntime.presenceFor(id), commands, clouds, circleCredits)
  registerComputerActivityRoutes(app, runtimeServices.computerActivity)
  runtimeServices.computerAccounts = new ComputerAccountsService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands)
  registerComputerAccountsRoutes(app, runtimeServices.computerAccounts)
  runtimeServices.computerMaintenance = new FleetMaintenanceService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, new ComputerMaintenance({ ...maintenancePorts, browserRuntime: {
      status: () => composition.browser.runtime.status(), retry: async () => {
        const status = await composition.browser.runtime.retry(); composition.browser.profiles.wake(); return status
      } } }), {
      workerManifestSha256s: () => readProductionWorkerManifestSha256s({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      workerContentSha256s: () => readProductionWorkerContentSha256s({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      workerPublication: () => readProductionWorkerReleasePublication({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      connections: computerConnectionsReader(runtimeServices.computerAccounts, {
        list: (principal, harness, hostRef) => harnessSettings.mcp.list(principal, harness, hostRef),
        readMainClaudeServers: () => claudeUserMcpServers(maintenancePorts),
      }),
      codexUserMcpServers: () => harnessSettings.mcp.userServers('codex'),
      claudeUserMcpServers: () => claudeUserMcpServers(maintenancePorts),
      claudePlugins: async () => await maintenancePorts.find('claude')
        ? readClaudePlugins(maintenancePorts, AbortSignal.timeout(120_000)) : { plugins: [], marketplaces: [] },
      // Plugins from a local marketplace exist only on Main, so they are not copied to other computers.
      codexPlugins: async () => {
        if (!await maintenancePorts.find('codex')) return []
        const [plugins, marketplaces] = await Promise.all([
          installedPlugins(maintenancePorts, mainCodex.binary, AbortSignal.timeout(120_000)),
          pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000))])
        const local = new Set(marketplaces.filter(marketplace => marketplace.local).map(marketplace => marketplace.name))
        return plugins.filter(plugin => !local.has(plugin.pluginId.split('@').at(-1)!))
      },
      codexMarketplaces: async () => await maintenancePorts.find('codex')
        ? (await pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000)))
          .flatMap(marketplace => marketplace.gitSource ? [{ name: marketplace.name, source: marketplace.gitSource }] : []) : [],
    })
  registerComputerMaintenanceRoutes(app, runtimeServices.computerMaintenance)
  if (composition.closing) runtimeServices.computerMaintenance.stopAdmission()
  // Keep harnesses current and Main's MCP servers and plugins on every computer. Never under the test runners.
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test' && process.env.FOREMAN_CODE_COMPUTER_UPKEEP !== '0') {
    const upkeep = () => { void trackService('computer-upkeep', { cadenceMs: 6 * 60 * 60_000, deadlineMs: 2 * 60 * 60_000 },
      () => runtimeServices.computerMaintenance!.keepCurrent()).catch(error => app.log.warn({ err: error }, 'Computer upkeep failed')) }
    const firstUpkeep = setTimeout(upkeep, 120_000)
    const upkeepTimer = setInterval(upkeep, 6 * 60 * 60_000)
    // MCP server and plugin changes on Main reach the other computers within about a minute.
    const stopSourceSync = startWorkerPublicationSync(workerArtifactLocation({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
    () => trackService('fleet-source-sync', { cadenceMs: 60_000, deadlineMs: 30 * 60_000 },
      () => runtimeServices.computerMaintenance!.syncChangedSources()),
    error => app.log.warn({ err: error }, 'Fleet MCP and plugin sync failed'))
    firstUpkeep.unref(); upkeepTimer.unref()
    composition.stopComputerTimers = () => {
      clearTimeout(firstUpkeep)
      clearInterval(upkeepTimer)
      stopSourceSync()
    }
    if (composition.closing) composition.stopComputerTimers()
  }
  runtimeServices.computerGitHub = new ComputerGitHubService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, {
      accountChanged: target => runtimeServices.computerAccounts!.invalidate(target),
    })
  runtimeServices.computerSync = new ComputerSyncService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, undefined, () => {
      assertOpen()
      if (!runtimeOwner.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'Shared file sync requires the runtime owner.', 503)
    })
  registerComputerSyncRoutes(app, runtimeServices.computerSync)
  const syncTimer = setInterval(() => {
    void trackService('computer-sync', { cadenceMs: 30_000, deadlineMs: 10 * 60_000 },
      () => runtimeServices.computerSync!.poll()).catch(error => {
      app.log.warn({ err: error }, 'Shared file sync setup is pending')
    })
  }, 30_000)
  syncTimer.unref()
  composition.stopSyncTimer = () => { clearInterval(syncTimer) }
  if (composition.closing) { composition.stopSyncTimer(); runtimeServices.computerSync.stopAdmission() }
  runtimeServices.buildComputers = jobRuntime.buildComputers
  registerBuildComputerRoutes(app, jobRuntime.buildComputers)
  runtimeServices.jobs = jobRuntime.jobs
  const readAgentFiles = agentFileReader(() => deviceRuntime.endpointForDomains())

  return { clouds, discoverClouds, readAgentFiles, workspaceRoots, circleCredits, circleStandby }
}

async function initializeCircleCi(composition: ProductionComposition, machine: ProductionMainInstallation) {
  const { database, foundationSettings, commands, runtimeServices, app } = composition
  const registry = { list: async () => (await foundationSettings.getCircleAccounts()).value.accounts }
  const directory = new CircleAccountDirectory(systemHostCiPorts(), registry)
  const context = async (id: string) => {
    const account = await directory.context(id)
    if (!account) throw new DomainError('CI_CLOUD_UNAVAILABLE', 'This CircleCI login is no longer registered.', 409)
    return account
  }
  const options = { activeRuns: () => activeCiRuns(database.pool) }
  const mirrors = workspaceMirrors(database.pool)
  const mirrorList = workspaceMirrorList(database.pool)
  const clouds = cloudCis(machine.installationId, mirrors, {
    ...options, primaryContext: await context('default'), explicitCircleOrgs: true,
  })
  const cache = new CircleCreditCache(join(homedir(), '.local/share/foreman-code/circleci-usage', 'usage.json'))
  const circleCredits = new CircleCreditUsage(async id => (await context(id)).http, {
    allowance: () => withCiDatabaseReservation(database.pool, async () => {
      return (await foundationSettings.getCircleCreditAllowance()).value
    }),
    primaryOwner: async () => null,
  }, { cache })
  const circleStandby = new CircleStandby(() => circleOrganizations(clouds), circleCredits, cache)
  const circleOrgs = circleCiOrgs(clouds, machine.installationId, mirrors, mirrorList, {
    ...options, registry, context, standby: circleStandby, explicitPrimary: true,
    runningOrganizations: runningCircleCiOwners(database.pool, machine.installationId),
  })
  runtimeServices.circleAccounts = new CircleAccountsManagementService(foundationSettings, commands,
    new CircleAccountFleetStatus(database.pool, machine.installationId, directory, clouds, circleStandby), async id => {
    directory.invalidate(id)
    for (const cloud of clouds) if (cloud.provider.circleAccountId === id) cloud.invalidateReadiness()
    await circleOrgs.refresh()
    circleOrgs.invalidate()
    await circleOrgs.refresh()
  })
  registerCircleAccountRoutes(app, runtimeServices.circleAccounts)
  return { clouds, discoverClouds: () => circleOrgs.refresh(), circleCredits, circleStandby }
}

async function initializeCiServices(
  composition: ProductionComposition,
  machine: ProductionMainInstallation,
  computerServices: {
    clouds: ReturnType<typeof cloudCis>
    discoverClouds: () => Promise<void>
    readAgentFiles: ReadAgentFiles
    workspaceRoots: WorkspaceBoundLocationService
    circleCredits: CircleCreditUsage
    circleStandby: CircleStandby
  },
) {
  const { clouds, discoverClouds, readAgentFiles, workspaceRoots, circleCredits, circleStandby } = computerServices
  const {
    workerExecution,
    deviceRuntime,
    commands,
    runtimeServices,
    app,
    assertOpen,
    startupDatabase,
    database,
  } = composition
  const jobRuntime = composition.jobRuntime!

  // CI runs directly on build computers (Main included) from GitHub, like self-hosted runners.
  composition.hostCi = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), new GitCiCommits(),
    new ProductionHostCiEndpoint(database.pool, machine.installationId, () => deviceRuntime.endpointForDomains(), new HostCiRunner(),
      clouds, discoverClouds, workerExecution),
    agentSnapshots(database.pool, readAgentFiles), {
      reservedCloudSlots: configuredReservedCloudSlots(), circleCredits, circleStandby,
    })
  composition.hostCi.start()
  app.addHook('onClose', async () => { await composition.hostCi?.close() })
  const stopDeadlineSweeper = startStateDeadlineSweeper(database.pool, {
    ciRuns: now => composition.hostCi!.expireOverdueRuns(now),
    workerPublication: () => readProductionWorkerReleasePublication({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }) })
  app.addHook('onClose', async () => { stopDeadlineSweeper() })
  runtimeServices.ci = composition.hostCi
  runtimeServices.jobRuntimeProfiles = jobRuntime.profiles
  runtimeServices.ciRuntime = new CiRuntimeProvisioner(database.pool, jobRuntime.profiles, jobRuntime.sources,
    () => deviceRuntime.endpointForDomains(), commands, { changed: () => jobRuntime?.jobs.requestQueueWake(),
      main: () => jobRuntime?.mainCiRuntime })
  jobRuntime.jobs.runtimePreparation = runtimeServices.ciRuntime
  runtimeServices.ciEnrollment = new CiEnrollment(database.pool, commands, jobRuntime.profiles,
    runtimeServices.ciRuntime, new ProductionCiEnrollmentInventory(database.pool, jobRuntime.sources,
      () => deviceRuntime.endpointForDomains(), () => jobRuntime?.mainCiRuntime, workerExecution,
      new ManagedWorkspaceRootService(commands, workspaceRoots, jobRuntime.policies)),
    () => { if (!composition.closing) void composition.hostCi?.dispatch() })
  jobRuntime.profiles.enrollment = runtimeServices.ciEnrollment
  jobRuntime.buildComputers.enrollment = runtimeServices.ciEnrollment
  runtimeServices.ciEnrollment.request()
  const enrollmentTimer = setInterval(() => runtimeServices.ciEnrollment?.request(), 30_000)
  enrollmentTimer.unref()
  app.addHook('onClose', async () => {
    clearInterval(enrollmentTimer)
    await runtimeServices.ciEnrollment?.close()
  })
  await startupDatabase(() => runtimeServices.ciRuntime!.recover())
  jobRuntime.jobs.requestQueueWake()
  registerSourceRoutes(app, jobRuntime.sources)
  registerJobRoutes(app, jobRuntime.jobs)
  registerJobRuntimeProfileRoutes(app, jobRuntime.profiles, runtimeServices.ciRuntime)
  assertOpen()

}

async function initializeHarnessServices(composition: ProductionComposition, machine: ProductionMainInstallation) {
  const {
    processRegistry,
    deviceRuntime,
    commands,
    remoteWorkflow,
    harnessRegistry,
    qualificationRegistry,
    harnessQualifications,
    harnessCompatibility,
    installationMonitor,
    harnessCatalog,
    nativeConfigurations,
    harnessSettings,
    launchScopes,
    approvals,
    telemetryLifetime,
    agentChat,
    runtimeServices,
    app,
    runtimeOwner,
    assertOpen,
    startupDatabase,
    database,
  } = composition

  harnessSettings.mcp.configureDevices(new DeviceManagedMcp(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands))
  await startupDatabase(() => harnessRegistry.initialize(machine.installationId))
  assertOpen()
  if (processRegistry instanceof NativeProcessRegistry) {
    const registry = processRegistry
    composition.mainTelemetryContext = { kind: 'main-local', mainId: machine.installationId,
      // Approved canonical alias for the Main, not a separate hardware UUID.
      deviceId: machine.installationId, applicationInstallationId: machine.installationId,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      runtimeEpoch: await startupDatabase(() => runtimeOwner.readRuntimeEpoch()), capability: RESOURCE_TELEMETRY_CAPABILITY }
    const authorities = createPassiveTelemetryAuthorities({ pool: database.pool, registry,
      mainContext: () => composition.mainTelemetryContext, mainActive: () => !composition.closing && runtimeOwner.active,
      deviceBinding: id => deviceRuntime.currentBinding(id), presence: id => deviceRuntime.presenceFor(id),
      deviceCapabilities: id => deviceRuntime.endpointForDomains().capabilities(id),
      getRemoteNativeOwners: () => remoteWorkflow.getRemoteNativeOwners(),
      getNativeOwners: () => approvals.passiveOwnedNativeSessions().flatMap(owned => {
        const captured = launchScopes.get(owned.manager)
        return captured ? [{ execution: owned.execution, session: owned.session, writer: owned.writer, generation:owned.generation, assertCurrent: owned.assertCurrent, nativeOwner: captured.owner }] : []
      }) })
    composition.telemetry = await createResourceTelemetryRuntime({ localContext: composition.mainTelemetryContext, registry, ...authorities,
      // A Main inside a container sees only its namespace, never the whole computer.
      wholeHostVisible: !existsSync('/.dockerenv') && !existsSync('/run/.containerenv'), signal: telemetryLifetime.signal })
    runtimeServices.resourceTelemetry = { reads: composition.telemetry.service, selectors: composition.telemetry.selectors }
    const audit = { record: (principalId: string, source: 'http' | 'mcp', selectorKey: string) =>
      commands.recordDenied(principalId, source, 'resource_telemetry_read', selectorKey) }
    registerResourceTelemetryRoutes(app, composition.telemetry.service, audit)
    registerResourceTelemetrySelectorRoutes(app, composition.telemetry.selectors, {
      record: (principalId, source, selectorKey) => commands.recordDenied(principalId, source, 'resource_telemetry_selector_get', selectorKey),
    })
    void composition.telemetry.completion.then(result => {
      if (result.kind !== 'failed') return
      reportServiceFailure('telemetry-collector', result.error)
      app.log.error({ err: result.error }, 'passive resource telemetry collector failed')
    })
    assertOpen()
  }
  // Optional discovery warmups used to block startup on native auth/network.
  // Qualification still runs at every existing on-demand configuration/execution gate.
  // The bounded compatibility diagnostic creates no native session or model turn.
  if (qualificationRegistry && harnessQualifications) {
    await qualificationRegistry.load(startupDatabase)
  }
  harnessCompatibility.start()
  assertOpen()
  composition.initialized = true
  // Reconcile chat turns interrupted by the previous process; never blocks startup.
  void agentChat.recover().catch((error: unknown) => app.log.error({ err: error }, 'agent chat recovery failed'))
  // Fill the settings status and model caches in the background so first reads do not wait on native checks.
  void Promise.allSettled([harnessCatalog.warmup(), nativeConfigurations.options('codex'), nativeConfigurations.options('claude'),
    harnessSettings.mcp.warmup(['codex']), harnessSettings.plugins.warmup(), harnessSettings.claudePlugins.warmup()])
  // Deployment can change the launcher or environment; restore a previously qualified Codex binary.
  if (harnessQualifications) void harnessQualifications.restore('codex').catch((error: unknown) =>
    app.log.warn({ err: error }, 'Main Codex requalification after restart failed'))
  installationMonitor.start(machine.installationId)
}
