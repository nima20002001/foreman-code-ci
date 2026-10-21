import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { integrationProcessProgress, waitForIntegrationProcess } from './integration-process.mjs'
import { reusableIntegrationFile } from './integration-slot-process.mjs'
import { integrationEnvironmentCapabilities, partitionIntegrationCapabilities,
  supportsInstalledWorkerHost } from './integration-capabilities.mjs'
import { readVerificationEnvironment } from '../packages/contracts/src/verificationEnvironment.mjs'
import { exclusiveIntegrationFiles, requirements,
  userSystemdIntegrationFiles } from '../packages/contracts/src/integrationScheduling.mjs'
import { createTestRoot, removeTestRoot, requireTestServerUrl, testAdminUrl } from './test-resources.mjs'
import { migrationContentsHash } from './test-database-template.mjs'
import { readIntegrationStartup } from './integration-startup.mjs'
import { autoRetestFiles, discoverFiles, failedCasesFromLog, failedFilesFromLog, failForSkippedCases,
  finalizeIntegrationResult, fullRunExitCode, hasActiveHeavyJobToken, hasHeavyJobAdmission,
  hungContext, integrationDurationsPath, integrationEnvironment, integrationReport, measuredDurations,
  integrationLogPath, integrationProgressLine, integrationShardLimit, integrationShardPlan,
  integrationTimeouts, integrationVitestArguments, integrationGate,
  isIntegrationTestPath, isRegularIntegrationFile, mergeDurations, options, orderByDuration, parseVitestCases,
  partitionIntegrationFiles, readDurations, readIntegrationResources, reservedIntegrationShards,
  scheduleFiles, scheduleIntegrationQueue, selectFiles, selectExactFiles,
  signalOwnedChildren, vitestCommand, writeDurations } from './test-integration.mjs'

const startupReporter = new URL('./integration-startup-reporter.mjs', import.meta.url).pathname
const terminalRecoveryFiles = [
  'apps/api/test/recovery-terminal-before-closure-approval.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-repeat-success.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-retry-exhausted.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-retry.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-sequential-success.integration.test.ts',
  'apps/api/test/recovery-terminal-before-closure-stop.integration.test.ts',
]
const startupStorageFiles = [
  'apps/api/test/test-startup-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-file-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-harness-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-workspace-storage-isolation.integration.test.ts',
  'apps/api/test/test-startup-mcp-storage-isolation.integration.test.ts',
]

test('migration template keys include ordered versions and SQL contents', () => {
  const migrations = [{ version: 1, sql: 'first migration' }, { version: 2, sql: 'second migration' }]
  const key = migrationContentsHash(migrations)
  assert.equal(migrationContentsHash(migrations.map(migration => ({ ...migration }))), key)
  assert.notEqual(migrationContentsHash([{ ...migrations[0], sql: 'changed migration' }, migrations[1]]), key)
  assert.notEqual(migrationContentsHash([{ ...migrations[0], version: 3 }, migrations[1]]), key)
  assert.notEqual(migrationContentsHash([...migrations].reverse()), key)
})

test('startup records retain phase timings independently of ordinary or truncated output', () => {
  const output = 'ordinary output\n'
    + '[integration-startup] {"phase":"worker-setup","elapsedMs":100}\n'
    + '[integration-startup] {"phase":"schema-fixture-ready","elapsedMs":400,"migrationMs":200}\n'
    + '[integration-startup] {"phase":"invalid","elapsedMs":-1}\n'
    + '[integration-startup] {"phase":"truncated"\n'
    + '[integration-startup] {"phase":"first-case-ready","elapsedMs":500}\n'
  assert.deepEqual(readIntegrationStartup(output), [
    { phase: 'worker-setup', elapsedMs: 100 },
    { phase: 'schema-fixture-ready', elapsedMs: 400, migrationMs: 200 },
    { phase: 'first-case-ready', elapsedMs: 500 },
  ])
})

test('the installed Job environment reports its unsupported host capabilities without probing the host', async () => {
  const environment = { FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1', PATH: '/no-tools' }
  assert.deepEqual(await integrationEnvironmentCapabilities(environment), {
    schemaVersion: 1, runtime: 'isolated-job',
    capabilities: { nativeCgroupDelegation: true, testDatabaseStartup: true, dockerCompose: false, installedWorkerHost: false },
    postgres: 'job-private', git: 'mounted-readonly',
  })
  assert.equal(readVerificationEnvironment({}), null)
  assert.throws(() => readVerificationEnvironment({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'unknown' }), /Unknown/)
  assert.throws(() => readVerificationEnvironment({ FOREMAN_CODE_VERIFICATION_ROOT: '/workspace' }), /missing/)
  await assert.rejects(integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'unknown' }), /Unknown/)
  await assert.rejects(integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ROOT: '/workspace' }), /missing/)
})

test('native and database startup suites run in the private Job without Docker', async () => {
  const files = ['apps/api/test/local-human-native.integration.test.ts',
    'apps/api/test/operator-file-delivery.integration.test.ts',
    'apps/api/test/operator-management-file-authority.integration.test.ts',
    'apps/api/test/test-database-startup.integration.test.ts'];
  const environment = await integrationEnvironmentCapabilities({
    FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1', PATH: '/no-tools',
  });
  assert.equal(environment.capabilities.dockerCompose, false);
  assert.deepEqual(partitionIntegrationCapabilities(files, environment), { runnable: files, unavailable: [] });
});

test('installed Worker capability requires an approved matching target and persistent root, home and state', () => {
  const target = { os: 'ubuntu', osRelease: '26.04', arch: 'x64', libc: 'glibc-2.43', node: 'v22.23.2' }
  const facts = { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true }
  assert.equal(supportsInstalledWorkerHost(facts, [target]), true)
  assert.equal(supportsInstalledWorkerHost(facts, []), false)
  for (const field of ['rootPersistent', 'homePersistent', 'storagePersistent']) {
    assert.equal(supportsInstalledWorkerHost({ ...facts, [field]: false }, [target]), false)
  }
  const unsupported = { os: 'debian', osRelease: '12', arch: 'arm64', libc: 'glibc-2.36', node: 'v22.23.3' }
  for (const [field, value] of Object.entries(unsupported)) {
    assert.equal(supportsInstalledWorkerHost({ ...facts, [field]: value }, [target]), false)
  }
  const debian = { ...facts, os: 'debian', osRelease: '12' }
  assert.equal(supportsInstalledWorkerHost(debian, [debian]), false)
})

test('each affected integration file runs only when its required capability is present', () => {
  const requirements = [
    ['apps/api/test/local-human-native.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/operator-file-delivery.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/operator-management-file-authority.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/test-database-startup.integration.test.ts', 'testDatabaseStartup'],
    ['apps/api/test/workflow-systemd-restart.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/workflow-systemd-installed-service.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/workflow-systemd-active-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/workflow-systemd-restart-unit-cleanup.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/native-service-restart.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/computer-workflow-save.regression-directories.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/computer-workflow-save.regression-reservation-cleanup-preparing.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/computer-workflow-save.regression-reservation-cleanup-completed.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-defaults.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-delivery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-entry-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-main-crash.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-main-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-reserved-decision.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production-worker-crash.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/historical-chat-placement-fork.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/historical-chat-placement-recovery.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/historical-chat-placement-disabled-profile.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-chat-profile-qualification.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-profile-requalification-main-restart.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-profile-requalification-worker-reconnect.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-profile-requalification-failed-check.integration.test.ts', 'installedWorkerHost'],
  ]
  for (const [file, capability] of requirements) {
    const environment = { schemaVersion: 1, runtime: 'host',
      capabilities: { nativeCgroupDelegation: true, testDatabaseStartup: true, dockerCompose: true, installedWorkerHost: true } }
    assert.deepEqual(partitionIntegrationCapabilities([file], environment), { runnable: [file], unavailable: [] })
    environment.capabilities[capability] = false
    const { runnable, unavailable } = partitionIntegrationCapabilities([file], environment)
    assert.deepEqual(runnable, [])
    assert.equal(unavailable.length, 1)
    assert.deepEqual(unavailable[0].requiredCapabilities, [capability])
    assert.equal(unavailable[0].complete, false)
    assert.equal(unavailable[0].code, null)
  }
})

test('installed API packaging and recovery files run exclusively while publication stays parallel', () => {
  const installed = [
    'apps/api/test/workflow-systemd-installed-service.integration.test.ts',
    'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
    'apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts',
  ]
  const ordinary = 'apps/api/test/workflow-systemd-restart-unit-publication.integration.test.ts'
  assert.deepEqual(partitionIntegrationFiles([...installed, ordinary]), {
    exclusive: installed,
    parallel: [ordinary],
  })
})

test('retained remote review recovery files run alone in a fresh process on an installed Worker host', () => {
  const recovery = [
    'apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts',
    'apps/api/test/remote-review-main-recovery.integration.test.ts',
  ]
  const ordinary = 'apps/api/test/remote-review-changes.integration.test.ts'
  assert.deepEqual(partitionIntegrationFiles([...recovery, ordinary]), { exclusive: recovery, parallel: [ordinary] })
  const environment = { schemaVersion: 1, runtime: 'host', capabilities: { nativeCgroupDelegation: true,
    testDatabaseStartup: true, dockerCompose: true, installedWorkerHost: false } }
  const { runnable, unavailable } = partitionIntegrationCapabilities(recovery, environment)
  assert.deepEqual(runnable, [])
  assert.deepEqual(unavailable.map(file => file.requiredCapabilities), recovery.map(() => ['installedWorkerHost']))
  for (const file of recovery) assert.equal(reusableIntegrationFile(file), false)
  assert.equal(reusableIntegrationFile(ordinary), true)
})

test('unsupported integration files remain required and prevent a complete or passing report', async () => {
  const native = 'apps/api/test/operator-file-delivery.integration.test.ts'
  const database = 'apps/api/test/test-database-startup.integration.test.ts'
  const ordinary = 'apps/api/test/operator-mcp.integration.test.ts'
  const selected = [native, database, ordinary]
  const installed = await integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1' })
  const environment = { ...installed, capabilities: { ...installed.capabilities,
    nativeCgroupDelegation: false, testDatabaseStartup: false } }
  const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
  assert.deepEqual(runnable, [ordinary])
  assert.deepEqual(unavailable.map(file => file.requiredCapabilities), [['nativeCgroupDelegation'], ['testDatabaseStartup']])
  const counts = { total: 1, passed: 1, failed: 0, skipped: 0 }
  const passed = { file: ordinary, code: 0, complete: true, report: { totals: counts } }
  const report = integrationReport(selected, [...unavailable, passed], [], {
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), diagnostic: false,
    processStopped: true, environment,
  })
  assert.equal(report.outcome, 'incomplete')
  assert.equal(report.completeness, 'partial')
  assert.equal(report.expectedPortions, 3)
  assert.equal(report.completedPortions, 1)
  assert.equal(report.totals.skipped, 0)
  assert.deepEqual(report.files.slice(0, 2), unavailable.map(file => ({ ...file,
    totals: { total: 0, passed: 0, failed: 0, skipped: 0 },
  })))
  assert.deepEqual(report.environment, environment)
  assert.deepEqual(partitionIntegrationCapabilities(selected, {
    capabilities: { nativeCgroupDelegation: true, testDatabaseStartup: true, dockerCompose: true, installedWorkerHost: true },
  }), { runnable: selected, unavailable: [] })
})

test('installed Worker suites remain unavailable and nonzero even when explicitly selected in a Job', async () => {
  const files = [
    'apps/api/test/workflow-systemd-restart.integration.test.ts',
    'apps/api/test/native-service-restart.integration.test.ts',
    'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
    'apps/api/test/computer-workflow-save.regression-reservation-cleanup-preparing.integration.test.ts',
    'apps/api/test/computer-workflow-save.regression-reservation-cleanup-completed.integration.test.ts',
    'apps/api/test/remote-review-production-defaults.integration.test.ts',
    'apps/api/test/remote-review-production-delivery.integration.test.ts',
    'apps/api/test/remote-review-production-entry-recovery.integration.test.ts',
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts',
    'apps/api/test/remote-review-main-recovery.integration.test.ts',
    'apps/api/test/remote-review-production-reserved-decision.integration.test.ts',
    'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
    'apps/api/test/worker-chat-profile-qualification.integration.test.ts',
    'apps/api/test/worker-profile-requalification-main-restart.integration.test.ts',
    'apps/api/test/worker-profile-requalification-worker-reconnect.integration.test.ts',
    'apps/api/test/worker-profile-requalification-failed-check.integration.test.ts',
  ]
  const environment = await integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1' })
  for (const requested of [files, ...files.map(file => [file])]) {
    const selected = selectExactFiles(files, requested)
    const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
    assert.deepEqual(runnable, [])
    assert.deepEqual(unavailable.map(file => file.requiredCapabilities), selected.map(() => ['installedWorkerHost']))
    const report = integrationReport(selected, unavailable, [], {
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), diagnostic: requested.length === 1,
      processStopped: true, environment,
    })
    assert.equal(report.outcome, 'incomplete')
    assert.equal(report.completeness, 'partial')
    assert.equal(report.expectedPortions, selected.length)
    assert.equal(report.completedPortions, 0)
    assert.deepEqual(report.totals, { total: 0, passed: 0, failed: 0, skipped: 0 })
    assert.ok(report.files.every(file => file.code === null && file.complete === false))
    assert.equal(fullRunExitCode(unavailable.length, null), 1)
  }
})

test('diagnostic case selection preserves file and worker limits and passes the pattern as one argument', () => {
  const files = [
    'apps/api/test/remote-review-production-defaults.integration.test.ts',
    'apps/api/test/remote-review-production-delivery.integration.test.ts',
    'apps/api/test/remote-review-production-entry-recovery.integration.test.ts',
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts',
    'apps/api/test/remote-review-main-recovery.integration.test.ts',
    'apps/api/test/remote-review-production-reserved-decision.integration.test.ts',
    'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
  ]
  for (const file of files) {
    const unfiltered = ['run', file.slice('apps/api/'.length), '--no-file-parallelism',
      '--maxWorkers=1', '--maxConcurrency=1', '--reporter=verbose', `--reporter=${startupReporter}`, '--fsModuleCache']
    assert.deepEqual(integrationVitestArguments(file), unfiltered)
    const pattern = 'delivered remote decision|reserved decision'
    assert.deepEqual(integrationVitestArguments(file, pattern), [...unfiltered, '--testNamePattern', pattern])
    assert.deepEqual(autoRetestFiles([file], { diagnostic: true, interrupted: null }), [file])
  }
  assert.equal(failForSkippedCases({ skipped: 5 }, false), true)
  assert.equal(failForSkippedCases({ skipped: 5 }, true), false)
})

test('integration discovery takes a sorted snapshot with startup included', () => {
  const files = discoverFiles()
  assert.ok(files.length > 0)
  assert.deepEqual(files, [...files].sort())
  assert.equal(new Set(files).size, files.length)
  assert.ok(files.includes('apps/api/test/dev-startup.integration.test.ts'))
  assert.ok(files.every((file) => file.startsWith('apps/api/test/') && file.endsWith('.integration.test.ts')))
})

for (const [name, entries] of [
  ['capability requirements', requirements.keys()],
  ['user systemd', userSystemdIntegrationFiles],
  ['exclusive scheduling', exclusiveIntegrationFiles],
]) test(`${name} entries refer to discovered integration files`, () => {
  const discovered = new Set(discoverFiles())
  assert.deepEqual([...entries].filter(file => !discovered.has(file)), [])
})

for (const [name, files] of [
  ['terminal recovery', terminalRecoveryFiles],
  ['startup storage isolation', startupStorageFiles],
]) test(`${name} suites run exclusively in fresh processes`, () => {
  const ordinary = 'apps/api/test/ordinary.integration.test.ts'
  const partition = partitionIntegrationFiles([...files, ordinary])
  assert.deepEqual(partition.exclusive.slice().sort(), files.slice().sort())
  assert.deepEqual(partition.parallel, [ordinary])
  for (const file of files) assert.equal(reusableIntegrationFile(file), false, file)
})

test('discovery accepts valid Git filenames and rejects non-normal paths', () => {
  assert.equal(isIntegrationTestPath('apps/api/test/foo.bar.integration.test.ts'), true)
  assert.equal(isIntegrationTestPath('apps/api/test/nested/foo bar+v2.integration.test.ts'), true)
  assert.equal(isIntegrationTestPath('apps/api/test/../foo.integration.test.ts'), false)
  assert.equal(isIntegrationTestPath('apps/api/test//foo.integration.test.ts'), false)
  assert.equal(isIntegrationTestPath('/apps/api/test/foo.integration.test.ts'), false)
})

test('discovery rejects symlinked test files and parent directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'integration-discovery-'))
  try {
    const directory = join(base, 'apps/api/test')
    mkdirSync(directory, { recursive: true })
    const file = 'apps/api/test/with space+v2.integration.test.ts'
    writeFileSync(join(base, file), '')
    assert.equal(isRegularIntegrationFile(base, file), true)
    symlinkSync(join(base, file), join(directory, 'linked.integration.test.ts'))
    assert.equal(isRegularIntegrationFile(base, 'apps/api/test/linked.integration.test.ts'), false)
    symlinkSync(directory, join(directory, 'linked-dir'))
    assert.equal(isRegularIntegrationFile(base, 'apps/api/test/linked-dir/with space+v2.integration.test.ts'), false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('stale or forged heavy-job tokens do not count as queue admission', () => {
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
  const environment = { FOREMAN_CODE_HEAVY_JOB_COMMON: '/git/common', FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-token' }
  const owner = { token: 'owned-token', pid: process.pid, start }
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', owner), true)
  assert.equal(hasActiveHeavyJobToken({ ...environment, FOREMAN_CODE_HEAVY_JOB_TOKEN: 'stale' }, '/git/common', owner), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/other/common', owner), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', { ...owner, start: 'stale' }), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', null), false)
})

test('resume includes the selected file so a repaired failure is rerun', () => {
  const files = ['a', 'b', 'c']
  assert.deepEqual(selectFiles(files, 'b'), ['b', 'c'])
  assert.deepEqual(selectFiles(files, 'c'), ['c'])
  assert.throws(() => selectFiles(files, 'missing'), /Unknown --start-at/)
})

test('requested integration files select only discovered files once in discovery order', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts',
    'apps/api/test/c.integration.test.ts']
  assert.deepEqual(selectExactFiles(files, [files[2], files[0], files[2]]), [files[0], files[2]])
  assert.throws(() => selectExactFiles(files, []), /at least one integration file/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/missing.integration.test.ts']), /Unknown --files/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/../a.integration.test.ts']), /Unknown --files/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/a.test.ts']), /Unknown --files/)
})

test('the runner accepts an explicit file list and rejects an empty list', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  assert.deepEqual(options(['--files', ...files]), { startAt: null, failedFrom: null, files })
  assert.throws(() => options(['--files']), /Usage/)
  assert.deepEqual(options([]), { startAt: null, failedFrom: null, files: null })
})

test('failed-log selection includes only discovered failures once', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  const log = '[integration] FAIL apps/api/test/b.integration.test.ts (slot 2, exit 1); log: /tmp/b\n'
    + '[integration] PASS apps/api/test/a.integration.test.ts (slot 1; 2 cases passed, 0 skipped)\n'
    + '[integration] RETEST FAIL apps/api/test/a.integration.test.ts (slot 1, exit 1); log: /tmp/retest-a\n'
    + '[integration] FAIL apps/api/test/b.integration.test.ts (slot 2, exit 1); log: /tmp/b\n'
  assert.deepEqual(failedFilesFromLog(log, files), ['apps/api/test/b.integration.test.ts'])
  assert.throws(() => failedFilesFromLog('[integration] FAIL apps/api/test/unknown.integration.test.ts (slot 1, exit 1)\n', files), /Unknown failed/)
  assert.throws(() => failedFilesFromLog('no failures', files), /no failed files/)
})

test('isolates bounded resource checks and retains every requested file exactly once', () => {
  const files = ['apps/api/test/ordinary.integration.test.ts',
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
    'apps/api/test/entrypoints-source-approval-profile.integration.test.ts',
    'apps/api/test/production-lifecycle-approvals.integration.test.ts',
    'apps/api/test/production-lifecycle-continuations.integration.test.ts',
    'apps/api/test/production-lifecycle-delivery.integration.test.ts',
    'apps/api/test/dev-startup.integration.test.ts']
  const partition = partitionIntegrationFiles(files)
  assert.deepEqual(partition.parallel, [files[0]])
  assert.deepEqual(partition.exclusive, [files[16], files[12], ...files.slice(1, 12), ...files.slice(13, 16)])
  assert.deepEqual([...partition.exclusive, ...partition.parallel].sort(), [...files].sort())
  assert.deepEqual(partitionIntegrationFiles([files[0]]), { exclusive: [], parallel: [files[0]] })
})

test('exact-file selection runs only requested discovered files once', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts',
    'apps/api/test/c.integration.test.ts']
  assert.deepEqual(selectExactFiles(files, [files[1], files[1]]), [files[1]])
  assert.deepEqual(selectExactFiles(files, [files[2], files[0], files[2]]), [files[0], files[2]])
  assert.throws(() => selectExactFiles(files, []), /at least one/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/unknown.integration.test.ts']), /Unknown --files/)
})

test('nested integration files retain distinct log paths', () => {
  const first = integrationLogPath('/tmp/run', 'apps/api/test/one/shared.integration.test.ts')
  const second = integrationLogPath('/tmp/run', 'apps/api/test/two/shared.integration.test.ts')
  assert.notEqual(first, second)
  assert.match(first, /one\/shared\.integration\.test\.ts\.log$/)
  assert.throws(() => integrationLogPath('/tmp/run', 'apps/api/test/../outside.integration.test.ts'), /Invalid integration log path/)
})

test('case totals parse mixed and colored Vitest summaries', () => {
  assert.deepEqual(parseVitestCases(' Tests  \x1b[32m7 passed\x1b[0m | 2 skipped (9)\n'), { passed: 7, failed: 0, skipped: 2, total: 9 })
  assert.deepEqual(parseVitestCases(' Tests  2 failed | 3 passed | 1 todo (6)\n'), { passed: 3, failed: 2, skipped: 1, total: 6 })
  assert.equal(parseVitestCases('Vitest crashed before its summary'), null)
})

test('skipped cases fail a clean full run while a diagnostic resume reports them', () => {
  const summary = { passed: 2, failed: 0, skipped: 1, total: 3 }
  assert.equal(failForSkippedCases(summary, null), true)
  assert.equal(failForSkippedCases(summary, 'apps/api/test/file.integration.test.ts'), false)
  assert.equal(failForSkippedCases({ ...summary, skipped: 0 }, null), false)
})

test('each selected first-pass failure receives one retest unless interrupted', () => {
  const failed = ['b', 'a', 'b']
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, interrupted: null }), ['a', 'b'])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: true, interrupted: null }), ['a', 'b'])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, interrupted: 'SIGINT' }), [])
})

test('a successful retest cannot make a failed first pass green', () => {
  assert.equal(fullRunExitCode(1, null), 1)
  assert.equal(fullRunExitCode(0, null), 0)
  assert.equal(fullRunExitCode(1, 'SIGINT'), 130)
  assert.equal(fullRunExitCode(1, 'SIGTERM'), 143)
})

test('integration shard validation retains the fallback and accepts a computed ceiling', () => {
  assert.equal(integrationShardLimit(undefined), 12)
  assert.equal(integrationShardLimit('8'), 8)
  assert.equal(integrationShardLimit('12'), 12)
  assert.equal(integrationShardLimit('16'), 16)
  assert.throws(() => integrationShardLimit('0'), /integer from 1 to 64/)
  assert.throws(() => integrationShardLimit('65'), /integer from 1 to 64/)
  assert.equal(integrationShardLimit('96', 128), 96)
  assert.throws(() => integrationShardLimit('17', 16), /integer from 1 to 16/)
})

const shardResources = {
  cpuCount: 16, availableMemoryBytes: 32 * 1024 ** 3,
  maxConnections: 800, reservedConnections: 3, activeConnections: 1,
}

test('a capable sixteen-CPU machine runs one integration shard per CPU and reports its resource limits', () => {
  const plan = integrationShardPlan({}, shardResources)
  assert.equal(plan.shards, 16)
  assert.equal(plan.limit, 16)
  assert.match(plan.reason, /CPU limit 16/)
  assert.match(plan.reason, /memory limit 21.*1.5 GiB\/shard/)
  assert.match(plan.reason, /PostgreSQL limit 49.*max_connections=800.*3 reserved.*1 occupied.*16 connections\/shard/)
})

test('each resource independently bounds integration parallelism', () => {
  for (const [resources, expected] of [
    [{ cpuCount: 4 }, 4],
    [{ availableMemoryBytes: 3.5 * 1024 ** 3 }, 2],
    [{ maxConnections: 100 }, 6],
    [{ activeConnections: 556 }, 15],
    [{ reservedConnections: 560 }, 14],
  ]) {
    assert.equal(integrationShardPlan({}, { ...shardResources, ...resources }).shards, expected)
  }
})

test('integration shards use their CI slot CPU and memory shares rather than the whole computer', () => {
  const environment = { FOREMAN_CODE_CI_CPU_COUNT: '8', FOREMAN_CODE_CI_MEMORY_BYTES: String(6 * 1024 ** 3) }
  const plan = integrationShardPlan(environment, shardResources)
  assert.equal(plan.shards, 4)
  assert.match(plan.reason, /CPU limit 8/)
  assert.match(plan.reason, /memory limit 4/)
  assert.match(plan.reason, /CI slot share/)
  assert.equal(integrationShardPlan(environment, { ...shardResources, availableMemoryBytes: 3 * 1024 ** 3 }).shards, 2)
  assert.throws(() => integrationShardPlan({ ...environment, FOREMAN_CODE_CI_CPU_COUNT: '0' }, shardResources), /CPU count/)
  assert.equal(integrationShardPlan({ ...environment, FOREMAN_CODE_INTEGRATION_SHARDS: '20' }, shardResources).shards, 4)
})

test('a sixteen-CPU host with a 4.4 GiB CI slot runs two integration shards', () => {
  const environment = {
    FOREMAN_CODE_CI_CPU_COUNT: '6',
    FOREMAN_CODE_CI_MEMORY_BYTES: String(Math.floor(4.4 * 1024 ** 3)),
  }
  const plan = integrationShardPlan(environment, shardResources)
  assert.equal(plan.shards, 2)
  assert.equal(plan.limit, 2)
  assert.match(plan.reason, /memory limit 2.*1.5 GiB\/shard/)
})

test('CI shard ceilings respect database capacity without rejecting the run', () => {
  const environment = { FOREMAN_CODE_CI_INTEGRATION_SHARDS: '12' }
  assert.equal(integrationShardPlan(environment, shardResources).shards, 12)
  const plan = integrationShardPlan(environment, { ...shardResources, maxConnections: 100 })
  assert.equal(plan.shards, 6)
  assert.match(plan.reason, /PostgreSQL limit 6/)
  assert.equal(integrationShardPlan({ FOREMAN_CODE_CI_INTEGRATION_SHARDS: '4' }, shardResources).shards, 4)
  assert.throws(() => integrationShardPlan({ FOREMAN_CODE_CI_INTEGRATION_SHARDS: '0' }, shardResources),
    /integer from 1 to 64/)
})

test('unknown or invalid resource measurements retain twelve without ignoring known smaller limits', () => {
  assert.equal(integrationShardPlan({}).shards, 12)
  for (const field of Object.keys(shardResources)) {
    const plan = integrationShardPlan({}, { ...shardResources, [field]: undefined })
    assert.equal(plan.shards, 12)
    assert.match(plan.reason, /unknown \(fallback 12\)/)
  }
  assert.equal(integrationShardPlan({}, { cpuCount: 4 }).shards, 4)
  assert.equal(integrationShardPlan({}, { cpuCount: NaN, availableMemoryBytes: -1 }).shards, 12)
})

test('explicit shard requests run at most at the computed resource cap', () => {
  for (const variable of ['GRAPHQL_INTEGRATION_SHARDS', 'FOREMAN_CODE_INTEGRATION_SHARDS']) {
    assert.equal(integrationShardPlan({ [variable]: '16' }, shardResources).shards, 16)
    const smaller = integrationShardPlan({ [variable]: '8' }, shardResources)
    assert.equal(smaller.shards, 8)
    assert.match(smaller.reason, /requested 8/)
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
      assert.throws(() => integrationShardPlan({ [variable]: value }, shardResources), /positive integer/)
    }
    assert.equal(integrationShardPlan({ [variable]: '33' }, shardResources).shards, 16)
    assert.equal(integrationShardPlan({ [variable]: '13' }).shards, 12)
  }
})

test('resource-derived capacity can exceed the old explicit ceiling on larger machines', () => {
  const plan = integrationShardPlan({ GRAPHQL_INTEGRATION_SHARDS: '80' }, {
    ...shardResources, cpuCount: 96, availableMemoryBytes: 144 * 1024 ** 3, maxConnections: 1600,
  })
  assert.equal(plan.limit, 96)
  assert.equal(plan.shards, 80)
})

test('runnable file count bounds chosen shards and appears in the explanation', () => {
  const plan = integrationShardPlan({}, shardResources, 2)
  assert.equal(plan.shards, 2)
  assert.equal(plan.limit, 16)
  assert.match(plan.reason, /2 runnable files/)
  assert.equal(integrationShardPlan({}, shardResources, 0).shards, 0)
})

test('known resources that cannot support a shard fail before allocating databases', () => {
  for (const resources of [
    { availableMemoryBytes: 0 },
    { availableMemoryBytes: 1.5 * 1024 ** 3 - 1 },
    { maxConnections: 19 },
    { activeConnections: 800 },
  ]) {
    assert.throws(() => integrationShardPlan({}, { ...shardResources, ...resources }), /No integration shard fits/)
  }
})

test('unavailable database settings fail discovery without exposing connection errors', async () => {
  const host = { cpuCount: 16, availableMemoryBytes: 32 * 1024 ** 3 }
  const admin = { query: async () => { throw new Error('private database connection details') } }
  await assert.rejects(readIntegrationResources(admin, host), error => {
    assert.match(error.message, /PostgreSQL capacity discovery failed/)
    assert.doesNotMatch(error.message, /private database/)
    return true
  })
})

test('integration deadlines allow four-minute cases plus hooks and scale with pressure', () => {
  const limits = integrationTimeouts({})
  assert.equal(limits.idleTimeoutMs, 300_000)
  assert.equal(limits.fileTimeoutMs, 300_000)
  const pressured = integrationTimeouts({}, 2)
  assert.equal(pressured.idleTimeoutMs, 2 * limits.idleTimeoutMs)
  assert.equal(pressured.fileTimeoutMs, 2 * limits.fileTimeoutMs)
  assert.equal(integrationTimeouts({ FOREMAN_CODE_INTEGRATION_IDLE_TIMEOUT_MS: '5000' }).idleTimeoutMs, 5000)
  for (const value of ['0', '-1', 'Infinity', 'NaN', '3600001', '1.5']) {
    assert.throws(() => integrationTimeouts({ FOREMAN_CODE_INTEGRATION_FILE_TIMEOUT_MS: value }), /integer/)
  }
})

test('progress distinguishes twelve configured slots from a draining file and retest queue', () => {
  const active = new Map([[3, { file: 'slow.integration.test.ts',
    progress: { started: 1000, lastOutputAt: 6000, bytes: 2048 } }]])
  const line = integrationProgressLine({ phase: 'first pass', total: 175,
    passed: 171, failed: 3, active, slotCount: 12 }, 11_000)
  assert.match(line, /174\/175 completed \(171 passed, 3 failed\); 1\/12 slots active; 0 queued/)
  assert.match(line, /slot 3: slow.integration.test.ts, elapsed 10s, output idle 5s, 2048 bytes/)
  const retest = integrationProgressLine({ phase: 'retest', total: 2,
    passed: 0, failed: 0, active, slotCount: 12 }, 11_000)
  assert.match(retest, /PROGRESS retest: 0\/2 completed.*1\/12 slots active; 1 queued/)
  const retired = integrationProgressLine({ phase: 'first pass', total: 175,
    passed: 171, failed: 3, active, slotCount: 12, usableCount: 11 }, 11_000)
  assert.match(retired, /1\/12 slots active; 0 queued; 1 retired/)
})

test('a failed file is reported while the remaining files continue', async () => {
  const waiting = new Map()
  const started = []
  const runFile = (slot, file) => new Promise((resolve) => {
    started.push({ slot, file })
    waiting.set(file, resolve)
  })
  const pending = scheduleFiles(['a', 'b', 'c', 'd'], [1, 2], runFile)
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b'])
  waiting.get('a')({ code: 1 })
  await Promise.resolve()
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b', 'c'])
  waiting.get('b')({ code: 0 })
  await Promise.resolve()
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b', 'c', 'd'])
  waiting.get('c')({ code: 0 })
  waiting.get('d')({ code: 0 })
  const result = await pending
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.outcomes.map(({ file, code }) => [file, code]).sort(), [['a', 1], ['b', 0], ['c', 0], ['d', 0]])
})

test('an interruption stops new dispatch without interrupting already-running files', async () => {
  let stop = false
  let finish
  const pending = scheduleFiles(['a', 'b', 'c'], [1], () => new Promise((resolve) => { finish = resolve }), () => stop)
  stop = true
  finish({ code: 0 })
  const result = await pending
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.outcomes.map(({ file }) => file), ['a'])
})

test('slots draw the next file only when their current file finishes', async () => {
  const waiting = new Map()
  const started = []
  const pending = scheduleFiles(['a', 'b', 'c'], [1, 2], (slot, file) => new Promise((resolve) => {
    started.push([slot, file])
    waiting.set(file, resolve)
  }))
  waiting.get('b')({ code: 0 })
  await Promise.resolve()
  assert.deepEqual(started, [[1, 'a'], [2, 'b'], [2, 'c']])
  waiting.get('a')({ code: 0 })
  waiting.get('c')({ code: 0 })
  assert.equal((await pending).skipped, 0)
})

test('twelve slots start twelve files and refill an available slot after a failure', async () => {
  const files = Array.from({ length: 13 }, (_, index) => `file-${index + 1}`)
  const slots = Array.from({ length: integrationShardLimit() }, (_, index) => index + 1)
  const waiting = new Map()
  const started = []
  const pending = scheduleFiles(files, slots, (slot, file) => new Promise((resolve) => {
    started.push([slot, file])
    waiting.set(file, resolve)
  }))
  assert.equal(started.length, 12)
  assert.equal(new Set(started.map(([slot]) => slot)).size, 12)
  waiting.get('file-4')({ code: 1 })
  await Promise.resolve()
  assert.deepEqual(started.at(-1), [4, 'file-13'])
  for (const [file, finish] of waiting) if (file !== 'file-4') finish({ code: 0 })
  const result = await pending
  assert.equal(result.outcomes.length, 13)
  assert.equal(result.skipped, 0)
  assert.equal(result.outcomes.filter(({ code }) => code !== 0).length, 1)
})

test('interrupt escalates a TERM-ignoring owned process group without awaiting its exit', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const timers = new Map()
  let timeout
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    signalOwnedChildren(new Map([[1, { child }]]), timers, 'SIGTERM', 100)
    const signal = await Promise.race([
      new Promise((resolve) => child.once('exit', (_code, value) => resolve(value))),
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('TERM-ignoring child did not exit')), 2000) }),
    ])
    assert.equal(signal, 'SIGKILL')
  } finally {
    clearTimeout(timeout)
    for (const timer of timers.values()) clearTimeout(timer)
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
  }
})

test('lists failing case names from a Vitest log', () => {
  const log = '\x1b[31m FAIL \x1b[39m test/a.integration.test.ts > suite > breaks\n FAIL  test/a.integration.test.ts > suite > breaks\n FAIL  test/b.integration.test.ts [ test/b.integration.test.ts ]\n ✓ passes'
  assert.deepEqual(failedCasesFromLog(log), ['suite > breaks'])
})

test('database gates and storage paths use the current owned slot, overriding inherited destinations', () => {
  const resource = createTestRoot()
  const databaseUrl = new URL('/graphql_test_owned', testAdminUrl).toString()
  const slot = { ...resource, databaseUrl }
  const inherited = { TEST_DATABASE_URL: 'postgresql://remote/live', DATABASE_URL: 'postgresql://remote/live',
    JOB_DISPATCH_DATABASE_URL: 'postgresql://remote/live', SUBAGENT_CORE_ADMIN_DATABASE_URL: 'postgresql://remote/live',
    HRT_F03_DATABASE_URL: 'postgresql://remote/live', ENG03_A_TEST_DATABASE_URL: 'postgresql://remote/live',
    NIM2691_ADMIN_DATABASE_URL: 'postgresql://remote/live', HRT_F14_ADMIN_DATABASE_URL: 'postgresql://remote/live',
    HOME: '/real/home', CODEX_HOME: '/real/codex', TMPDIR: '/inherited' }
  try {
    const environment = integrationEnvironment(inherited, slot)
    for (const name of Object.keys(inherited).filter(key => key.endsWith('DATABASE_URL'))) {
      assert.equal(environment[name], slot.databaseUrl)
    }
    assert.equal(environment.NIM2691_POSTGRES, '1')
    assert.equal(environment.TMPDIR, join(slot.directory, 'tmp'))
    assert.ok(environment.HOME.startsWith(slot.directory + '/'))
    assert.ok(environment.CODEX_HOME.startsWith(slot.directory + '/'))
    assert.equal(inherited.HRT_F14_ADMIN_DATABASE_URL, 'postgresql://remote/live')
    const retest = integrationEnvironment(environment, { ...slot, databaseUrl: databaseUrl + '_retest' })
    assert.equal(retest.HRT_F14_ADMIN_DATABASE_URL, databaseUrl + '_retest')
    for (const url of ['postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      'postgresql://graphql_test_admin:graphql_test_disposable_only@remote:55439/test', databaseUrl + '?options=unsafe']) {
      assert.throws(() => integrationEnvironment(inherited, { ...slot, databaseUrl: url }), /dedicated disposable/)
    }
    assert.throws(() => integrationEnvironment(inherited, { ...slot, token: 'another-owner' }), /ownership/)
  } finally { removeTestRoot(resource) }
})

test('the runner database selector accepts only the dedicated disposable server', () => {
  assert.equal(requireTestServerUrl(testAdminUrl).href, testAdminUrl)
  assert.equal(requireTestServerUrl(new URL('/graphql_test_selected', testAdminUrl).href).pathname,
    '/graphql_test_selected')
  for (const url of ['postgresql://graphql:graphql@127.0.0.1:5432/graphql',
    testAdminUrl.replace('127.0.0.1', 'remote'), `${testAdminUrl}?options=unsafe`]) {
    assert.throws(() => requireTestServerUrl(url), /dedicated disposable/)
  }
})

test('admission recognizes legacy and secondary slots and rejects forged, stale and foreign records', () => {
  const common = mkdtempSync(join(tmpdir(), 'integration-admission-'))
  try {
    const state = join(common, 'graphql-heavy-jobs')
    const legacy = join(state, 'active', 'owner.json')
    const running = join(state, 'running')
    mkdirSync(join(state, 'active'), { recursive: true })
    mkdirSync(running)
    const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
    const owner = { common, token: 'owned-token', pid: process.pid, start }
    const environment = { FOREMAN_CODE_HEAVY_JOB_COMMON: common, FOREMAN_CODE_HEAVY_JOB_TOKEN: owner.token }
    writeFileSync(legacy, JSON.stringify(owner))
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    writeFileSync(legacy, JSON.stringify({ ...owner, token: 'another-slot' }))
    const secondary = join(running, '000000000002-secondary')
    writeFileSync(secondary, JSON.stringify(owner))
    writeFileSync(join(running, '000000000001-malformed'), '{')
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    assert.equal(hasHeavyJobAdmission({ ...environment, FOREMAN_CODE_HEAVY_JOB_TOKEN: 'forged' }, common), false)
    assert.equal(hasHeavyJobAdmission({ ...environment, FOREMAN_CODE_HEAVY_JOB_COMMON: '/other/common' }, common), false)
    for (const invalid of [{ ...owner, start: 'stale' }, { ...owner, common: '/other/common' }, { ...owner, pid: 0 }]) {
      writeFileSync(secondary, JSON.stringify(invalid))
      assert.equal(hasHeavyJobAdmission(environment, common), false)
    }
    writeFileSync(secondary, JSON.stringify(owner))
    rmSync(legacy)
    assert.equal(hasHeavyJobAdmission(environment, common), true)
  } finally { rmSync(common, { recursive: true, force: true }) }
})


test('machine reports keep first-pass failures after a successful fresh-DB diagnostic', () => {
  const failed = { file: 'a', code: 1, complete: true, report: {
    totals: { total: 2, passed: 1, failed: 1, skipped: 0 }, files: [] } }
  const retest = { file: 'a', code: 0, complete: true, report: {
    totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, files: [] } }
  const report = integrationReport(['a'], [failed], [retest], {
    startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true })
  assert.equal(report.outcome, 'failed')
  assert.equal(report.firstPassFailed, 1)
  assert.equal(report.totals.failed, 1)
  assert.equal(report.retests[0].totals.failed, 0)
  assert.equal(report.files[0].status, 'FLAKY')
  assert.equal(report.files[0].code, 1)
  assert.equal(fullRunExitCode(report.firstPassFailed, null), 1)
})

test('missing JSON, unexecuted files and interruption retain an honest partial report', () => {
  const firstPass = [{ file: 'a', code: 0, complete: true,
    report: { totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, files: [] } },
  { file: 'b', code: 1, complete: false, reportError: 'missing JSON' }]
  const settings = { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true }
  const partial = integrationReport(['a', 'b', 'c'], firstPass, [], settings)
  assert.equal(partial.outcome, 'incomplete')
  assert.equal(partial.completeness, 'partial')
  assert.equal(partial.completedPortions, 1)
  assert.equal(partial.files[2].reason, 'not executed')
  assert.equal(partial.totals.passed, 2)
  const cancelled = integrationReport(['a', 'b', 'c'], firstPass, [], { ...settings, interrupted: 'SIGTERM' })
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(cancelled.totals.passed, 2)
})

test('skipped cases and diagnostic resumes cannot satisfy a complete integration gate', () => {
  const firstPass = [{ file: 'a', code: 0, complete: true,
    report: { totals: { total: 2, passed: 1, failed: 0, skipped: 1 }, files: [] } }]
  const settings = { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true }
  const full = integrationReport(['a'], firstPass, [], settings)
  assert.equal(full.outcome, 'failed')
  assert.equal(full.disallowedSkipped, 1)
  const diagnostic = integrationReport(['a'], firstPass, [], { ...settings, diagnostic: true })
  assert.equal(diagnostic.outcome, 'incomplete')
  assert.equal(diagnostic.completeness, 'partial')
})


test('Job integration shards require and respect both reservation and qualification', () => {
  assert.equal(reservedIntegrationShards({}), 12)
  const job = { FOREMAN_CODE_VERIFICATION_ROOT: '/source',
    FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '1', FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS: '1' }
  assert.equal(reservedIntegrationShards(job), 1)
  assert.throws(() => reservedIntegrationShards({ FOREMAN_CODE_VERIFICATION_ROOT: '/source' }), /require reserved/)
  assert.throws(() => reservedIntegrationShards({ ...job, GRAPHQL_INTEGRATION_SHARDS: '2' }), /exceed/)
  assert.throws(() => reservedIntegrationShards({ ...job, FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '2',
    GRAPHQL_INTEGRATION_SHARDS: '2' }), /exceed/)
})

test('computed capacity preserves Job reservations and qualification checks', () => {
  const job = { FOREMAN_CODE_VERIFICATION_ROOT: '/source',
    FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '16', FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS: '16' }
  assert.equal(integrationShardPlan(job, shardResources).shards, 16)
  const plan = integrationShardPlan(job, { ...shardResources, cpuCount: 4 })
  assert.equal(plan.shards, 4)
  assert.match(plan.reason, /CI reservation 16, qualification 16/)
  assert.equal(integrationShardPlan({ ...job, GRAPHQL_INTEGRATION_SHARDS: '9' },
    { ...shardResources, cpuCount: 4 }).shards, 4)
  assert.equal(integrationShardPlan({ ...job, FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '4' },
    shardResources).shards, 4)
  assert.throws(() => integrationShardPlan({ ...job, FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '4',
    GRAPHQL_INTEGRATION_SHARDS: '8' }, shardResources), /exceed/)
  assert.throws(() => integrationShardPlan({ ...job, FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS: '4' },
    shardResources), /exceed/)
})

test('slowest recorded files start first and unmeasured files lead the queue', async () => {
  const files = ['unmeasured-b', 'fast', 'slow', 'same-speed', 'unmeasured-a']
  const durations = { fast: 5000, slow: 90000, 'same-speed': 5000 }
  const ordered = orderByDuration(files, durations)
  assert.deepEqual(ordered, ['unmeasured-b', 'unmeasured-a', 'slow', 'fast', 'same-speed'])
  const started = []
  await scheduleFiles(ordered, [1], async (_slot, file) => {
    started.push(file)
    return { code: 0 }
  })
  assert.deepEqual(started, ordered)
  assert.deepEqual(files, ['unmeasured-b', 'fast', 'slow', 'same-speed', 'unmeasured-a'])
})

test('recorded durations persist across runs, replace earlier ones and forget removed files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-durations-'))
  try {
    const path = join(directory, 'cache', 'durations.json')
    writeDurations(path, { gone: 1, kept: 2, updated: 3 })
    writeDurations(path, mergeDurations(readDurations(path), { updated: 30 }, ['kept', 'updated']))
    assert.deepEqual(readDurations(path), { kept: 2, updated: 30 })
    assert.deepEqual(orderByDuration(['kept', 'updated'], readDurations(path)), ['updated', 'kept'])
    assert.deepEqual(mergeDurations({ invalid: -1 }, { infinite: Infinity, string: '3', zero: 0 },
      ['invalid', 'infinite', 'string', 'zero']), { zero: 0 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('missing or corrupt duration records fall back to discovery order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-durations-'))
  try {
    const path = join(directory, 'durations.json')
    assert.deepEqual(readDurations(path), {})
    for (const contents of ['{', 'null', '[]', '42']) {
      writeFileSync(path, contents)
      assert.deepEqual(readDurations(path), {})
      assert.deepEqual(orderByDuration(['b', 'a'], readDurations(path)), ['b', 'a'])
    }
    assert.deepEqual(orderByDuration(['b', 'a'], { b: -1, a: 'invalid' }), ['b', 'a'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('integration files launch workspace Vitest directly with package binaries and isolated state', () => {
  const resource = createTestRoot()
  try {
    const file = 'apps/api/test/dev-startup.integration.test.ts'
    const slot = { ...resource, databaseUrl: new URL('/graphql_test_owned', testAdminUrl).href }
    const environment = integrationEnvironment({ PATH: process.env.PATH }, slot)
    const json = join(resource.directory, 'vitest.json')
    const vitest = vitestCommand(environment, file, 'first case|second case', json)
    assert.deepEqual(vitest.args, ['run', 'test/dev-startup.integration.test.ts', '--no-file-parallelism',
      '--maxWorkers=1', '--maxConcurrency=1', '--reporter=verbose', '--reporter=json',
      `--outputFile.json=${json}`, `--reporter=${startupReporter}`, '--fsModuleCache', '--testNamePattern', 'first case|second case'])
    assert.equal(vitest.env.TEST_DATABASE_URL, slot.databaseUrl)
    assert.equal(vitest.env.HOME, environment.HOME)
    assert.equal(vitest.env.FOREMAN_CODE_TEST_OWNER, resource.token)
    const version = spawnSync(vitest.command, ['--version'], { cwd: vitest.cwd, env: vitest.env, encoding: 'utf8' })
    assert.equal(version.status, 0, version.stderr || version.error?.message)
    assert.match(version.stdout, /vitest\/\d+/)
    const tsx = spawnSync('tsx', ['--version'], { cwd: vitest.cwd, env: vitest.env, encoding: 'utf8' })
    assert.equal(tsx.status, 0, tsx.stderr || tsx.error?.message)
    assert.match(tsx.stdout, /tsx v\d+/)
    assert.equal(environment.PATH, process.env.PATH)
  } finally { removeTestRoot(resource) }
})

const lowPressure = () => ({ cpuUtilization: 0, cpuPressure: 0,
  memoryPressure: 0, memoryUtilization: 0, totalMemoryBytes: 16 * 1024 ** 3, cpuCount: 8 })

const installedWorkerFiles = [
  'apps/api/test/remote-review-production-main-crash.integration.test.ts',
  'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
  'apps/api/test/remote-review-production-entry-recovery.integration.test.ts',
]
const measuredFiles = Array.from({ length: 9 }, (_, index) => `apps/api/test/measured-${index}.integration.test.ts`)
const ordinaryFiles = Array.from({ length: 5 }, (_, index) => `apps/api/test/ordinary-${index}.integration.test.ts`)
const cpuSchedulingCases = [
  {
    name: 'four CPUs admit two nonexclusive installed-Worker files even with short measurements',
    capacity: 4, files: installedWorkerFiles,
    durations: Object.fromEntries(installedWorkerFiles.map(file => [file, 1000])),
    cost: () => 2, firstWave: [installedWorkerFiles[0], installedWorkerFiles[2]],
  },
  {
    name: 'failed heavy files release CPU capacity and retest on healthy database slots',
    capacity: 4, files: installedWorkerFiles, failFile: installedWorkerFiles[0],
    cost: () => 2, firstWave: [installedWorkerFiles[0], installedWorkerFiles[2]],
  },
  {
    name: 'four CPUs admit long measured files in longest-first order',
    capacity: 4, files: measuredFiles.slice(0, 3),
    durations: { [measuredFiles[0]]: 60_000, [measuredFiles[1]]: 59_999, [measuredFiles[2]]: 70_000 },
    cost: file => file === measuredFiles[1] ? 1 : 2, firstWave: [measuredFiles[2], measuredFiles[0]],
  },
  {
    name: 'resource profiles classify long files and preserve longest-first order',
    capacity: 4, files: measuredFiles.slice(0, 3),
    profiles: Object.fromEntries(measuredFiles.slice(0, 3).map((file, index) => [file, { durationMs: 60_000 + index }])),
    cost: () => 2, firstWave: [measuredFiles[2], measuredFiles[1]],
  },
  {
    name: 'a long duration remains CPU-heavy when a shorter resource profile exists',
    capacity: 4, files: measuredFiles.slice(0, 3),
    durations: Object.fromEntries(measuredFiles.slice(0, 3).map(file => [file, 60_000])),
    profiles: Object.fromEntries(measuredFiles.slice(0, 3).map(file => [file, { durationMs: 1000 }])),
    cost: () => 2, firstWave: measuredFiles.slice(0, 2),
  },
  {
    name: 'a heavy file shares four CPU slots with one ordinary file and one gate check',
    capacity: 4, files: [ordinaryFiles[0], measuredFiles[0], ordinaryFiles[1], ordinaryFiles[2]],
    durations: { [measuredFiles[0]]: 60_000, [ordinaryFiles[0]]: 59_999 },
    profiles: { 'gate:check': { durationMs: 70_000 } }, extraItems: [{ id: 'gate:check' }],
    cost: file => file === measuredFiles[0] ? 2 : 1,
    firstWave: ['gate:check', measuredFiles[0], ordinaryFiles[0]],
  },
  {
    name: 'sixteen CPUs admit eight heavy files in parallel',
    capacity: 16, files: measuredFiles,
    durations: Object.fromEntries(measuredFiles.map(file => [file, 60_000])),
    cost: () => 2, firstWave: measuredFiles.slice(0, 8),
  },
  {
    name: 'a one-slot runner completes heavy files without stalling',
    capacity: 1, files: installedWorkerFiles,
    cost: () => 1, firstWave: installedWorkerFiles.slice(0, 1),
  },
  {
    name: 'ordinary and invalid-duration files retain all four CPU slots',
    capacity: 4, files: ordinaryFiles,
    durations: { [ordinaryFiles[0]]: NaN, [ordinaryFiles[1]]: Infinity, [ordinaryFiles[2]]: -1 },
    cost: () => 1, firstWave: ordinaryFiles.slice(0, 4),
  },
]

for (const scenario of cpuSchedulingCases) {
  test(scenario.name, { timeout: 2000 }, async () => {
    const waiting = new Map()
    const started = []
    let activeCost = 0
    let peakCost = 0
    let holding = true
    let firstWave
    let releaseHandle
    const execute = (id) => {
      started.push(id)
      if (!holding) return { code: 0, complete: true }
      return new Promise(resolve => waiting.set(id, resolve))
    }
    try {
      const result = await scheduleIntegrationQueue(scenario.files,
        Array.from({ length: scenario.capacity }, (_, index) => ({ index: index + 1 })), {
          maxConcurrency: scenario.capacity, durations: scenario.durations, profiles: scenario.profiles,
          extraItems: scenario.extraItems, pollIntervalMs: 0.01,
          samplePressure: () => {
            if (holding && activeCost >= scenario.capacity && !releaseHandle) {
              firstWave = [...started]
              // Release after this admission decision, so overbooking is observable.
              releaseHandle = setImmediate(() => {
                holding = false
                for (const [file, finish] of waiting) {
                  const failed = file === scenario.failFile
                  finish({ code: failed ? 1 : 0, complete: true, slotUnavailable: failed })
                }
                waiting.clear()
              })
            }
            return { ...lowPressure(), cpuCount: scenario.capacity }
          },
          onEvent: (event) => {
            if (event.type === 'start') activeCost += scenario.cost(event.item.id)
            if (event.type === 'finish') activeCost -= scenario.cost(event.item.id)
            peakCost = Math.max(peakCost, activeCost)
          },
          runFile: (_slot, file) => execute(file), executeExtra: item => execute(item.id),
        })
      assert.deepEqual(firstWave, scenario.firstWave)
      assert.equal(peakCost, scenario.capacity)
      assert.equal(activeCost, 0)
      assert.equal(result.unexecuted.length, 0)
      for (const item of result.results) {
        assert.equal(item.status, item.id === scenario.failFile ? 'FLAKY' : 'PASSED')
      }
      assert.equal(started.length, scenario.files.length + (scenario.extraItems?.length ?? 0)
        + (scenario.failFile ? 1 : 0))
    } finally {
      clearImmediate(releaseHandle)
      for (const finish of waiting.values()) finish({ code: 0, complete: true })
    }
  })
}

test('pending sibling settlement keeps its fixed deadline without competing queue work', async () => {
  const settlement = 'apps/api/test/engine-pending-sibling-settlement.integration.test.ts'
  const ordinary = 'apps/api/test/ordinary.integration.test.ts'
  const gate = 'gate:check'
  const events = []
  const active = new Set()
  const run = async id => {
    if (id === settlement) assert.equal(active.size, 0)
    else assert.equal(active.has(settlement), false)
    active.add(id)
    events.push(id)
    try {
      await new Promise(resolve => setImmediate(resolve))
      return { code: 0, complete: true }
    } finally {
      active.delete(id)
    }
  }
  const result = await scheduleIntegrationQueue([settlement, ordinary], [{ index: 1 }, { index: 2 }], {
    maxConcurrency: 2, samplePressure: lowPressure, pollIntervalMs: 0.01,
    durations: { [settlement]: 52_540 },
    extraItems: [{ id: gate }],
    runFile: (_slot, file) => run(file), executeExtra: item => run(item.id),
  })
  assert.equal(result.unexecuted.length, 0)
  assert.equal(result.results.length, 3)
  assert.equal(result.results.every(item => item.status === 'PASSED'), true)
  assert.deepEqual(new Set(events), new Set([settlement, ordinary, gate]))
  assert.equal(active.size, 0)
})

test('integration and gate checks share the bounded queue and delay exclusive files', async () => {
  const ordinary = 'apps/api/test/ordinary.integration.test.ts'
  const exclusive = 'apps/api/test/dev-startup.integration.test.ts'
  const events = []
  let active = 0
  let peak = 0
  const run = async (id, isolated = false) => {
    if (isolated) assert.equal(active, 0)
    active++
    peak = Math.max(peak, active)
    events.push(`start:${id}`)
    await new Promise((done) => setTimeout(done, 10))
    events.push(`end:${id}`)
    active--
    return { code: 0, complete: true }
  }
  const result = await scheduleIntegrationQueue([ordinary, exclusive], [{ index: 1 }, { index: 2 }], {
    maxConcurrency: 2, samplePressure: lowPressure, pollIntervalMs: 1,
    extraItems: [{ id: 'gate:lint' }, { id: 'gate:typecheck', dependsOn: ['gate:lint'] }],
    executeExtra: (item) => run(item.id),
    runFile: (_slot, file) => run(file, file === exclusive),
  })
  assert.equal(result.results.length, 4)
  assert.ok(result.results.every((item) => item.status === 'PASSED'))
  assert.ok(events.indexOf(`start:${exclusive}`) > events.indexOf(`end:${ordinary}`))
  assert.ok(events.indexOf('start:gate:typecheck') > events.indexOf('end:gate:lint'))
  assert.equal(peak, 2)
})

for (const [name, reservedReview] of [
  ['remote review decision delivery', 'apps/api/test/remote-review-production-delivery.integration.test.ts'],
  ['reserved remote review', 'apps/api/test/remote-review-production-reserved-decision.integration.test.ts'],
  ['remote review Worker crash recovery', 'apps/api/test/remote-review-production-worker-crash.integration.test.ts'],
  ['computer workflow directory save', 'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts'],
  ['remote review delivery', 'apps/api/test/remote-review-production-delivery.integration.test.ts'],
  ['historical workflow version pins', 'apps/api/test/workflow-historical-version-pins.integration.test.ts'],
  ['source snapshot retention', 'apps/api/test/source-snapshot-retention.integration.test.ts'],
  ...terminalRecoveryFiles.map(file => [`terminal recovery (${file})`, file]),
  ['six-node checkpoint routing', 'apps/api/test/eng03-b-durability-routing.integration.test.ts'],
]) test(`${name} runs without competing integration or gate processes`, async () => {
  const ordinary = 'apps/api/test/ordinary.integration.test.ts'
  const active = new Set()
  const overlaps = []
  let remainingPeers = 2
  let finishPeers
  const peersFinished = new Promise((resolve) => { finishPeers = resolve })
  const run = async (id) => {
    active.add(id)
    if (active.has(reservedReview) && active.size > 1) overlaps.push([...active])
    if (id === reservedReview) await peersFinished
    else {
      await new Promise(setImmediate)
      remainingPeers--
      if (remainingPeers === 0) finishPeers()
    }
    active.delete(id)
    return { code: 0, complete: true }
  }
  const result = await scheduleIntegrationQueue([reservedReview, ordinary],
    [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }], {
      maxConcurrency: 4, samplePressure: lowPressure, pollIntervalMs: 1,
      profiles: { [reservedReview]: { durationMs: 90_000 } },
      extraItems: [{ id: 'gate:lint' }],
      executeExtra: (item) => run(item.id),
      runFile: (_slot, file) => run(file),
    })
  assert.equal(result.results.length, 3)
  assert.ok(result.results.every((item) => item.status === 'PASSED'))
  assert.deepEqual(overlaps, [])
})

test('gate identity is explicit and full scope alone keeps diagnostic retests', () => {
  assert.equal(integrationGate({ FOREMAN_CODE_CI_GATE: '1' }), true)
  assert.equal(integrationGate({ FOREMAN_CODE_CI_INTEGRATION_SHARDS: '4' }), true)
  assert.equal(integrationGate({ SCOPE: 'full' }), false)
  assert.equal(integrationGate({ FOREMAN_CODE_CI_SCOPE: 'full' }), false)
  assert.equal(integrationGate({ FOREMAN_CODE_CI_GATE: '0' }), false)
  assert.equal(integrationGate({}), false)
})

test('gate failures return after one attempt without preparing an isolated retest', async () => {
  const file = 'apps/api/test/one.integration.test.ts'
  let attempts = 0
  const result = await scheduleIntegrationQueue([file], [{ index: 1 }], {
    gate: true, maxConcurrency: 1, samplePressure: lowPressure, pollIntervalMs: 1,
    prepareRetest: async () => assert.fail('Gate failures must not allocate retest resources'),
    runFile: async (_slot, selected, context) => {
      assert.equal(selected, file)
      assert.equal(context.isRetest, false)
      attempts++
      return { code: 1, complete: true }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(result.results[0].status, 'FAILED')
  assert.equal(result.results[0].attempts.length, 1)
})

test('worker ownership setup validates resources without loading API and execution contracts', () => {
  const resource = createTestRoot()
  try {
    const slot = { ...resource, databaseUrl: new URL('/graphql_test_owned', testAdminUrl).href }
    const environment = integrationEnvironment({ PATH: process.env.PATH }, slot)
    const helper = new URL('../apps/api/test/helpers/testResources.ts', import.meta.url).href
    const program = `
      import assert from 'node:assert/strict'
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === '@foreman-code/contracts' || specifier.startsWith('@foreman-code/contracts/')) {
          throw new Error('Domain validation is unavailable during worker ownership setup')
        }
        return nextResolve(specifier, context)
      } })
      const resources = await import(${JSON.stringify(helper)})
      assert.equal(resources.ownedTestDatabaseUrl(), process.env.TEST_DATABASE_URL)
      assert.equal(resources.ownedTestPath(process.env.FOREMAN_CODE_TEST_ROOT), process.env.FOREMAN_CODE_TEST_ROOT)
      assert.throws(() => resources.ownedTestDatabaseUrl('TEST_DATABASE_URL', {
        ...process.env, FOREMAN_CODE_TEST_OWNER: 'invalid-owner',
      }), /ownership/)
      await assert.rejects(resources.assertOwnedTestApi(new URL('https://example.invalid'), {}), /loopback/)
      await assert.rejects(resources.assertOwnedExecutionDestinations({ query: async () => ({ rows: [] }) }, {
        workspaceId: 'workspace-example',
      }), /Domain validation is unavailable/)
    `
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
      env: environment, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  } finally { removeTestRoot(resource) }
})

test('failed integrations retest serially after gate checks with fresh resources and load context', async () => {
  const files = ['apps/api/test/one.integration.test.ts', 'apps/api/test/two.integration.test.ts']
  const slots = [{ index: 1, generation: 0 }, { index: 2, generation: 0 }]
  const events = []
  let active = 0
  let gateFinished = false
  const result = await scheduleIntegrationQueue(files, slots, {
    maxConcurrency: 2, pollIntervalMs: 1,
    samplePressure: () => ({ ...lowPressure(), cpuUtilization: 0.8 }),
    extraItems: [{ id: 'gate:lint' }],
    executeExtra: async () => {
      active++
      await new Promise(setImmediate)
      active--
      gateFinished = true
      return { code: 0, complete: true }
    },
    prepareRetest: async (slot, file) => {
      assert.equal(active, 0)
      assert.equal(gateFinished, true)
      slot.generation++
      events.push(`fresh:${file}`)
    },
    runFile: async (slot, file, context) => {
      if (context.isRetest) {
        assert.equal(active, 0)
        assert.ok(slot.generation > 0)
      }
      assert.ok(context.timeoutScale > 1)
      active++
      events.push(`${context.attempt}:${file}`)
      await new Promise(setImmediate)
      active--
      return { code: context.isRetest ? 0 : 1, complete: true,
        metrics: { durationMs: 10, peakRssBytes: 1000, cpuSeconds: 0.001 } }
    },
  })
  for (const file of files) {
    const resultFile = result.results.find((entry) => entry.id === file)
    assert.equal(resultFile.status, 'FLAKY')
    assert.equal(resultFile.attempts.length, 2)
    assert.equal(events.filter((event) => event === `fresh:${file}`).length, 1)
    assert.deepEqual(result.profiles[file], { durationMs: 10, peakRssBytes: 1000, cpuSeconds: 0.001 })
  }
})

test('retired database slots leave other slots and non-database checks usable', async () => {
  const files = ['apps/api/test/one.integration.test.ts', 'apps/api/test/two.integration.test.ts',
    'apps/api/test/three.integration.test.ts']
  const slots = [{ index: 1 }, { index: 2 }]
  const attempts = []
  const extras = []
  const result = await scheduleIntegrationQueue(files, slots, {
    maxConcurrency: 2, samplePressure: lowPressure, pollIntervalMs: 1,
    extraItems: [{ id: 'gate:lint' }],
    executeExtra: async (item) => { extras.push(item.id); return { code: 0, complete: true } },
    runFile: async (slot, file, context) => {
      attempts.push([slot.index, file, context.attempt])
      await new Promise(setImmediate)
      return { code: slot.index === 1 ? 1 : 0, complete: true, slotUnavailable: slot.index === 1 }
    },
  })
  assert.equal(slots[0].unavailable, true)
  assert.equal(attempts.filter(([slot]) => slot === 1).length, 1)
  assert.equal(result.unexecuted.length, 0)
  assert.deepEqual(extras, ['gate:lint'])
  assert.equal(result.results.find((entry) => entry.id === files[0]).status, 'FLAKY')
})

test('a lost database pool reports unexecuted files while gate checks still finish', async () => {
  const files = ['apps/api/test/one.integration.test.ts', 'apps/api/test/two.integration.test.ts']
  const slots = [{ index: 1 }]
  const extras = []
  const result = await scheduleIntegrationQueue(files, slots, {
    maxConcurrency: 1, samplePressure: lowPressure, pollIntervalMs: 1,
    extraItems: [{ id: 'gate:lint' }],
    executeExtra: async (item) => { extras.push(item.id); return { code: 0, complete: true } },
    runFile: async () => ({ code: 1, complete: false, slotUnavailable: true }),
  })
  assert.deepEqual(extras, ['gate:lint'])
  assert.deepEqual(result.unexecuted.map((item) => item.id), [files[1]])
  assert.equal(result.results.find((item) => item.id === files[1]).status, 'NOT_RUN')
  assert.match(result.results.find((item) => item.id === files[1]).reason, /usable worker/i)
})

test('environment selectors remain mutually exclusive when passed to the exported runner options', () => {
  const file = 'apps/api/test/one.integration.test.ts'
  assert.deepEqual(options([], { GRAPHQL_INTEGRATION_START_AT: file }),
    { startAt: file, failedFrom: null, files: null })
  assert.throws(() => options(['--files', file], { GRAPHQL_INTEGRATION_FAILED_LOG: '/tmp/failed.log' }), /Usage/)
  assert.throws(() => options([], { GRAPHQL_INTEGRATION_START_AT: file,
    GRAPHQL_INTEGRATION_FAILED_LOG: '/tmp/failed.log' }), /Choose either/)
})

test('retained process ownership stops extras, exclusive files and retries', async () => {
  const file = 'apps/api/test/retained.integration.test.ts'
  const exclusive = 'apps/api/test/dev-startup.integration.test.ts'
  const slots = [{ index: 1 }]
  const attempts = []
  const failures = []
  const result = await scheduleIntegrationQueue([file, exclusive], slots, {
    maxConcurrency: 1, samplePressure: lowPressure, pollIntervalMs: 1,
    extraItems: [{ id: 'gate:lint' }],
    executeExtra: async (item) => { attempts.push(item.id); return { code: 0, complete: true } },
    prepareRetest: async () => assert.fail('Retest started with retained process ownership'),
    onProcessFailure: (reason) => failures.push(reason),
    runFile: async (_slot, file) => {
      attempts.push(file)
      return { code: 1, complete: false, slotUnavailable: true, ownedProcessActive: true,
        reason: 'Child process group 123 did not exit' }
    },
  })
  assert.deepEqual(attempts, [file])
  assert.deepEqual(failures, ['Child process group 123 did not exit'])
  assert.deepEqual(result.unexecuted.map((item) => item.id), [exclusive, 'gate:lint'])
  assert.equal(result.results.find((item) => item.id === file).attempts.length, 1)
})

test('retained process ownership cancels controls for already-running extra checks', async () => {
  const file = 'apps/api/test/retained.integration.test.ts'
  let cancelled = false
  let extraStarted = false
  const result = await scheduleIntegrationQueue([file], [{ index: 1 }], {
    maxConcurrency: 2, samplePressure: lowPressure, pollIntervalMs: 1,
    extraItems: [{ id: 'gate:lint' }],
    onProcessFailure: () => { cancelled = true },
    runFile: async () => {
      while (!extraStarted) await new Promise((done) => setTimeout(done, 1))
      return { code: 1, complete: false, slotUnavailable: true, ownedProcessActive: true }
    },
    executeExtra: async () => {
      extraStarted = true
      while (!cancelled) await new Promise((done) => setTimeout(done, 1))
      return { code: 143, complete: false, reason: 'Cancelled after retained integration process' }
    },
  })
  assert.equal(cancelled, true)
  assert.equal(result.results.find((item) => item.id === 'gate:lint').attempts.length, 1)
  assert.ok(result.results.every((item) => item.status === 'FAILED'))
})

test('cleanup failures retain completed queue attempts, persisted facts and cancellation codes', () => {
  const selected = ['apps/api/test/one.integration.test.ts']
  const firstPass = [{ file: selected[0], code: 0, complete: true,
    report: { totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, files: [] } }]
  const results = [{ id: selected[0], status: 'PASSED', attempts: [{ code: 0, complete: true }] },
    { id: 'gate:lint', status: 'PASSED', attempts: [{ code: 0, complete: true }] }]
  const cleanupError = new Error('Disposable database cleanup failed')
  for (const [interrupted, code] of [[null, 1], ['SIGINT', 130], ['SIGTERM', 143]]) {
    const report = integrationReport(selected, firstPass, [], {
      startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
      interrupted, diagnostic: false, processStopped: false,
    })
    const result = finalizeIntegrationResult({ report, results, selectedFiles: selected,
      reportDirectory: '/tmp/integration-reports', interrupted, diagnostic: false, cleanupError })
    assert.equal(result.code, code)
    assert.equal(result.results, results)
    assert.deepEqual(result.gateResults, [results[1]])
    assert.equal(result.report.completedPortions, 1)
    assert.deepEqual(result.report.totals, { total: 2, passed: 2, failed: 0, skipped: 0 })
    assert.equal(result.cleanupError, cleanupError.message)
    const persisted = JSON.parse(JSON.stringify(result.report))
    assert.equal(persisted.cleanupError, cleanupError.message)
    assert.equal(persisted.error, cleanupError.message)
    assert.equal(persisted.completeness, 'partial')
    assert.equal(persisted.outcome, interrupted ? 'cancelled' : 'incomplete')
  }
})

test('a hung file names the last case it finished and its last output line', () => {
  const log = ['\x1b[32m ✓\x1b[39m test/a.integration.test.ts > installs > reads the version 812ms',
    ' ✓ test/a.integration.test.ts > installs > updates the harness 1204ms',
    'waiting for the update lock', '', '[integration] TIMEOUT: hung: still running after its 80000 ms deadline', ''].join('\n')
  assert.deepEqual(hungContext(log), { lastCase: 'test/a.integration.test.ts > installs > updates the harness',
    lastOutput: 'waiting for the update lock' })
  assert.deepEqual(hungContext('[integration] TIMEOUT: hung\n'), { lastCase: null, lastOutput: null })
})

test('hung files are reported apart from failures, stay hung after a passing retest, and can be rerun from the log', () => {
  const hung = { file: 'a', code: 124, complete: false, timedOut: true, status: 'HUNG',
    hung: { expectedMs: 20_000, deadlineMs: 80_000, lastCase: 'suite > case', lastOutput: 'waiting' } }
  const failed = { file: 'b', code: 1, complete: true, report: {
    totals: { total: 1, passed: 0, failed: 1, skipped: 0 }, files: [] } }
  const retest = { file: 'a', code: 0, complete: true, report: {
    totals: { total: 1, passed: 1, failed: 0, skipped: 0 }, files: [] } }
  const report = integrationReport(['a', 'b'], [hung, failed], [retest], {
    startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true })
  assert.deepEqual(report.hungFiles, ['a'])
  assert.equal(report.files[0].status, 'HUNG')
  assert.deepEqual(report.files[0].hung, hung.hung)
  assert.equal(report.files[1].status, 'FAILED')
  assert.equal(report.firstPassFailed, 2)
  assert.notEqual(report.outcome, 'passed')
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  assert.deepEqual(failedFilesFromLog('[integration] HUNG apps/api/test/a.integration.test.ts (slot 2, exit 124); 90000 ms\n'
    + '[integration] FAIL apps/api/test/b.integration.test.ts (slot 1, exit 1); 10 ms\n', files), files)
})

test('only files that passed their first attempt contribute measured durations', () => {
  assert.deepEqual(measuredDurations([
    { file: 'passed', code: 0, complete: true, elapsedMs: 41_000 },
    { file: 'failed', code: 1, complete: true, elapsedMs: 2_000 },
    { file: 'hung', code: 124, complete: false, elapsedMs: 90_000, status: 'HUNG' },
    { file: 'incomplete', code: 0, complete: false, elapsedMs: 5_000 },
    { file: 'unavailable', code: null, complete: false },
  ]), { passed: 41_000 })
})

test('integration expectations use the retained snapshot unless explicitly overridden', () => {
  const snapshot = fileURLToPath(new URL('./ci-learned-durations.json', import.meta.url))
  assert.equal(integrationDurationsPath({}), existsSync(snapshot) ? snapshot : null)
  assert.deepEqual(readDurations(integrationDurationsPath({})), readDurations(snapshot))
  assert.equal(integrationDurationsPath({ FOREMAN_CODE_INTEGRATION_DURATIONS: '/runs/x/durations.json' }),
    '/runs/x/durations.json')
})

test('reports each file startup as the time until its test module was collected', async () => {
  const { startupText } = await import('./test-integration.mjs')
  assert.equal(startupText([{ phase: 'worker-setup', elapsedMs: 3412 }, { phase: 'module-collected', elapsedMs: 8526 }]),
    '; startup 8526 ms')
  assert.equal(startupText([{ phase: 'worker-setup', elapsedMs: 3412 }]), '')
})


test('database benchmarks and cold qualification restarts run without competing fixtures', () => {
  const measured = [
    'apps/api/test/ci-postgres-setup.integration.test.ts',
    'apps/api/test/main-codex-qualification-restart.integration.test.ts',
    'apps/api/test/main-codex-qualification-partial-version.integration.test.ts',
  ]
  const ordinary = 'apps/api/test/operator-context.integration.test.ts'
  const plan = partitionIntegrationFiles([...measured, ordinary])
  assert.deepEqual(new Set(plan.exclusive), new Set(measured))
  assert.deepEqual(plan.parallel, [ordinary])
})


test('a silent four-minute case survives the default outer watchdog', async t => {
  const resource = createTestRoot()
  const log = join(resource.directory, 'case.log')
  writeFileSync(log, '')
  const child = new EventEmitter()
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const pending = waitForIntegrationProcess(child, {
      log, progress: integrationProcessProgress(), ...integrationTimeouts({}),
    })
    t.mock.timers.tick(240_000)
    child.emit('exit', 0, null)
    assert.deepEqual(await pending, { code: 0, timedOut: false })
  } finally {
    t.mock.timers.reset()
    removeTestRoot(resource)
  }
})
