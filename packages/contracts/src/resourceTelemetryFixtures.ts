import { telemetrySelectorKey, type TelemetrySelector, type TelemetrySample, type TelemetryReadResult } from './resourceTelemetry.js'
const mainId = '11111111-1111-4111-8111-111111111111'
export const telemetryComputerFixture: TelemetrySelector = { schemaVersion: 1, scope: 'computer', mainId,
  host: { hostRef: { kind: 'main', mainId }, deviceId: '22222222-2222-4222-8222-222222222222',
    applicationInstallationId: 'main-installation', bootId: '33333333-3333-4333-8333-333333333333', runtimeEpoch: 'runtime-1',
    keyRevision: null, authorizationRevision: null, connectionGeneration: null, collectorGeneration: 'collector-1' } }
export const telemetryOwnedFixture: Extract<TelemetrySelector, { scope: 'owned' }> = { ...telemetryComputerFixture, scope: 'owned',
  owner: { kind: 'workflow-execution', workspaceId: 'workspace-1', workflowId: 'workflow-1', runId: 'run-1', nodeId: 'node-1',
    agentId: 'agent-1', executionId: 'execution-1', attemptId: 'attempt-1', operationId: 'operation-1',
    bindingHash: 'a'.repeat(64), owner: { grantId: 'grant-1', epoch: '1' } }, attributionRef: 'lease-1', attributionRevision: '1' }
const sample = (selector: TelemetrySelector): TelemetrySample => ({ schemaVersion: 1, selector, selectorKey: telemetrySelectorKey(selector),
  identity: { mainId, host: selector.host }, sampleId: 'fixture-sample-1', sequence: '1', collectedAtUnixMs: 1000,
  collectionDurationNs: '1000000', receivedAtUnixMs: 1001, serverNowUnixMs: 1001, ageUpperBoundMs: 1, freshUntilUnixMs: 7000,
  presence: 'online', ownershipState: 'active', diagnostics: [], coverage: { boundary: 'complete-boundary', shared: false, reasons: [] },
  cpu: { state: 'fresh', value: { basis: selector.scope === 'computer' ? 'host-active-ticks' : 'cgroup-usage-usec',
    normalization: 'whole-host-capacity', logicalCpuCount: 8, hostCapacityPercent: 0,
    oneCorePercent: selector.scope === 'computer' ? null : 0, elapsedNs: '2000000000', cpuDeltaNs: selector.scope === 'computer' ? null : '0' },
    reason: null, sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 },
  memory: { state: 'fresh', value: selector.scope === 'computer'
    ? { kind: 'host-used-estimate', bytes: 0, totalBytes: 8192, availableBytes: 8192, sharedPagesMayDoubleCount: false }
    : { kind: 'cgroup-current', bytes: 0, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: false },
    reason: null, sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 } })
const fresh = sample(telemetryOwnedFixture)
const computer = sample(telemetryComputerFixture)
const stale: TelemetrySample = { ...fresh, serverNowUnixMs: 7000, ageUpperBoundMs: 6000,
  cpu: { state: 'stale', value: null, reason: 'stale', sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 },
  memory: { state: 'stale', value: null, reason: 'stale', sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 } }
export const resourceTelemetryFixtures: Record<string, TelemetryReadResult> = {
  freshZero: { kind: 'sample', sample: fresh, lastKnown: fresh },
  computerZero: { kind: 'sample', sample: computer, lastKnown: computer },
  warmup: { kind: 'sample', sample: { ...fresh, cpu: { state: 'warmup', value: null, reason: 'warmup', sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 } }, lastKnown: null },
  staleOnline: { kind: 'sample', sample: stale, lastKnown: fresh },
  offline: { kind: 'sample', sample: { ...stale, presence: 'offline' }, lastKnown: fresh },
  permissionDenied: { kind: 'sample', sample: { ...fresh,
    cpu: { state: 'permission-denied', value: null, reason: 'permission-denied', sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 },
    memory: { state: 'permission-denied', value: null, reason: 'permission-denied', sampledAtUnixMs: 1000, freshUntilUnixMs: 7000 } }, lastKnown: null },
  denied: { kind: 'denied', selectorKey: telemetrySelectorKey(telemetryOwnedFixture) },
  partialRss: { kind: 'sample', sample: { ...fresh, coverage: { boundary: 'partial', shared: false, reasons: ['source-failure'] },
    memory: { ...fresh.memory, state: 'fresh', reason: null, sampledAtUnixMs: 1000, freshUntilUnixMs: 7000,
      value: { kind: 'rss-sum', bytes: 4096, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } } }, lastKnown: null },
  shared: { kind: 'sample', sample: { ...fresh, coverage: { boundary: 'partial', shared: true, reasons: ['shared-restricted'] } }, lastKnown: null },
  ended: { kind: 'sample', sample: { ...stale, ownershipState: 'ended' }, lastKnown: fresh },
  reboot: { kind: 'no-sample', selector: { ...telemetryComputerFixture, host: { ...telemetryComputerFixture.host,
    bootId: '44444444-4444-4444-8444-444444444444', runtimeEpoch: 'runtime-2' } },
    selectorKey: telemetrySelectorKey({ ...telemetryComputerFixture, host: { ...telemetryComputerFixture.host,
      bootId: '44444444-4444-4444-8444-444444444444', runtimeEpoch: 'runtime-2' } }), reason: 'not-yet-sampled', identity: null },
  notYetSampled: { kind: 'no-sample', selector: telemetryOwnedFixture, selectorKey: telemetrySelectorKey(telemetryOwnedFixture), reason: 'not-yet-sampled', identity: null },
}
/** Visit tokens remain UI-owned; the full selector key must also match each response. */
export const telemetrySelectionRaceFixture = [
  { visit: 1, selector: telemetryOwnedFixture, response: resourceTelemetryFixtures.freshZero!, delayMs: 300 },
  { visit: 2, selector: { ...telemetryOwnedFixture, attributionRevision: '2' },
    response: { kind: 'sample' as const, sample: sample({ ...telemetryOwnedFixture, attributionRevision: '2' }), lastKnown: null }, delayMs: 100 },
  { visit: 3, selector: telemetryOwnedFixture, response: resourceTelemetryFixtures.notYetSampled!, delayMs: 0 },
]
