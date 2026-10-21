export const requirements = new Map([
  ['apps/api/test/local-human-native.integration.test.ts', ['nativeCgroupDelegation']],
  ['apps/api/test/operator-file-delivery.integration.test.ts', ['nativeCgroupDelegation']],
  ['apps/api/test/operator-management-file-authority.integration.test.ts', ['nativeCgroupDelegation']],
  ['apps/api/test/test-database-startup.integration.test.ts', ['testDatabaseStartup']],
  ['apps/api/test/workflow-systemd-restart.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-installed-service.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-active-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-restart-unit-cleanup.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-restart-admitting-interval.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/workflow-systemd-restart-failed-admission.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/native-service-restart.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/computer-workflow-save.regression-directories.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/computer-workflow-save.regression-reservation-cleanup-preparing.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/computer-workflow-save.regression-reservation-cleanup-completed.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-defaults.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-delivery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-entry-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-main-crash.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-main-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-reserved-decision.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/remote-review-production-worker-crash.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/historical-chat-placement-fork.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/historical-chat-placement-recovery.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/historical-chat-placement-disabled-profile.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/worker-chat-profile-qualification.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/worker-profile-requalification-main-restart.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/worker-profile-requalification-worker-reconnect.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/worker-profile-requalification-failed-check.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-discovery-main.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-discovery-worker.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-claude-inventory.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-unavailable-main.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-unavailable-worker.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-qualification-drain.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-rollback.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-profiles-main.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-profiles-worker.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/harness-installation-update-failed-check.integration.test.ts', ['installedWorkerHost']],
  ['apps/api/test/job-qualification-native-faults.integration.test.ts', ['nativeCgroupDelegation']],
])

// These fixtures control services through systemctl --user; installed Worker processes alone do not need it.
export const userSystemdIntegrationFiles = new Set([
  'apps/api/test/workflow-systemd-installed-service.integration.test.ts',
  'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
  'apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts',
  'apps/api/test/workflow-systemd-restart-unit-cleanup.integration.test.ts',
  'apps/api/test/workflow-systemd-restart-admitting-interval.integration.test.ts',
  'apps/api/test/workflow-systemd-restart-failed-admission.integration.test.ts',
  'apps/api/test/native-service-restart.integration.test.ts',
])

const startupFile = 'apps/api/test/dev-startup.integration.test.ts'
// These files measure bounded startup/latency while exercising shared host resources.
export const exclusiveIntegrationFiles = [startupFile,
  // Measure server and native startup without competing fixture setup.
  'apps/api/test/ci-postgres-setup.integration.test.ts',
  'apps/api/test/main-codex-qualification-restart.integration.test.ts',
  'apps/api/test/main-codex-qualification-partial-version.integration.test.ts',
  // Checkpoint routing must settle within its fixed deadline under CI load.
  'apps/api/test/eng03-b-durability-routing.integration.test.ts',
  // Pending settlement and sibling approval resume share a fixed completion deadline.
  'apps/api/test/engine-pending-sibling-settlement.integration.test.ts',
  // Two sequential native executions must settle within the fixed completion deadline.
  'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
  // Sequential native startup and decision delivery share the fixed file deadline.
  'apps/api/test/remote-review-production-delivery.integration.test.ts',
  // Native review startup and reserved-decision recovery must fit the fixed file deadline.
  'apps/api/test/remote-review-production-reserved-decision.integration.test.ts',
  // Startup and original-owner recovery must finish within the same fixed file deadline.
  'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
  // Main recovery and the retained reviewer's continuation must finish within the same fixed case deadline.
  'apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts',
  'apps/api/test/remote-review-main-recovery.integration.test.ts',
  // Repeated schema migrations need uncontended host resources.
  'apps/api/test/workflow-historical-version-pins.integration.test.ts',
  'apps/api/test/source-snapshot-retention.integration.test.ts',
  // Terminal recovery must settle without competing fixture setup.
  'apps/api/test/recovery-terminal-before-closure-approval.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-repeat-success.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-retry-exhausted.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-retry.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-sequential-success.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-stop.integration.test.ts',
  // Keep installed API packaging sequential on each user-systemd host.
  'apps/api/test/workflow-systemd-installed-service.integration.test.ts',
  'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
  'apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts',
  'apps/api/test/workflow-systemd-restart-admitting-interval.integration.test.ts',
  'apps/api/test/workflow-systemd-restart-failed-admission.integration.test.ts',
  'apps/api/test/test-startup-isolation-environment.integration.test.ts',
  'apps/api/test/test-startup-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-file-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-harness-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-workspace-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-mcp-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-isolation-smoke.integration.test.ts',
  'apps/api/test/entrypoints-source-approval-profile.integration.test.ts',
  'apps/api/test/operator-chat-controls.integration.test.ts',
  'apps/api/test/operator-chat-preferences.integration.test.ts',
  'apps/api/test/operator-chat-compaction.integration.test.ts',
  'apps/api/test/operator-chat-handoffs.integration.test.ts',
  'apps/api/test/operator-chat-delegated-access.integration.test.ts',
  'apps/api/test/operator-chat-defaults.integration.test.ts',
  'apps/api/test/operator-chat-history.integration.test.ts',
  'apps/api/test/operator-chat-sessions.integration.test.ts',
  'apps/api/test/operator-chat-terminal.integration.test.ts',
  'apps/api/test/operator-chat-stop.integration.test.ts',
  'apps/api/test/operator-chat-streams.integration.test.ts',
  'apps/api/test/native-stream-lifecycle.integration.test.ts',
  'apps/api/test/production-lifecycle-approvals.integration.test.ts',
  'apps/api/test/production-lifecycle-continuations.integration.test.ts',
  'apps/api/test/production-lifecycle-delivery.integration.test.ts',
  'apps/api/test/local-production-deployment.integration.test.ts',
  'apps/api/test/production-mcp-upgrade.integration.test.ts',
  'apps/api/test/operator-file-delivery.integration.test.ts',
  'apps/api/test/operator-management-file-authority.integration.test.ts',
  'apps/api/test/r2-2-inherited-references.integration.test.ts',
]

/** CPU slots reserved by a file in both gate planning and execution.
 * @param {string} file
 * @param {number} shards
 * @param {...(number | undefined)} durations
 */
export function integrationCpuCost(file, shards, ...durations) {
  const heavy = requirements.get(file)?.includes('installedWorkerHost')
    || durations.some(ms => Number.isFinite(ms) && ms >= 60_000)
  return heavy ? Math.min(2, shards) : 1
}
