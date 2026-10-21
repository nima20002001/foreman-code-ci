import { assertArchivedLogs, assertJunitCases } from './test-support/verificationExports.mjs'
const fixtureGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { groupUsed } from './integration-process.mjs'
import { captureVerificationInventory, collectPortions, expectedPortions, finalizeVerification, prepareVerificationDirectory, runSuiteProcess,
  sampleVerificationResources, validateVerificationContext, verificationCommand, verifyOfflinePreseed,
  verifyPrivateGitHead, verificationScratchEnvironment } from './verify-repository.mjs'
import { portionPath, readNodeReport, runVerificationCommand, suiteSummary, writeReport } from './verification-reports.mjs'

function context(suite = 'unit') {
  const id = '11111111-1111-4111-8111-111111111111'
  const digest = 'a'.repeat(64)
  return { identity: {
    suite, commit: 'b'.repeat(40), manifestDigest: digest, definitionVersionId: 'definition-version',
    executionId: 'execution', attemptId: 'attempt',
    parameters: { unitWorkers: 1, integrationShards: 1 },
    resources: { schemaVersion: 1, limits: { cpuLimit: 1, memoryBytes: 2 ** 30, pidsLimit: 128, diskBytes: 8 * 2 ** 30 },
      mutableInodes: 100000, controlTempBytes: 2 ** 20, scratchBytes: 2 ** 30, scratchExecutable: true,
      shmBytes: 64 * 2 ** 20, spoolBytes: 2 ** 20, reportBytes: 4 * 2 ** 20 },
    target: { schemaVersion: 1, mainId: id, mainInstallationId: id, hostRef: { kind: 'main', mainId: id },
      registration: null, destination: { canonicalProjectRoot: '/approved/source', canonicalCwd: '/approved/source',
        managedRuntimeRoot: '/approved/runtime', directoryIdentityHash: digest, rootPolicyId: 'root',
        rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest } },
    profile: { profileId: 'profile', profileRevision: 1, qualificationId: id, rootId: id, bindingRevision: 1,
      fingerprintDigest: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest,
      network: { schemaVersion: 2, mode: 'none' }, approvalId: id,
      approvalExpiresAt: '2026-10-05T13:00:00.000Z', qualificationExpiresAt: '2026-10-05T13:00:00.000Z' },
  }, privateGit: { sourceCommit: 'b'.repeat(40), generatedCommit: 'c'.repeat(40),
    repositoryReceiptDigest: digest, configDigest: digest, indexDigest: digest },
  requiredPortions: [{ key: 'root:install', kind: 'command' }],
  mutableDirectory: '/mutable', storeDirectory: '/mutable/store', preseedReceipt: {}, qualifiedUnitWorkers: 1, qualifiedIntegrationShards: 1, executionTimeoutMs: 2000, cancellationTimeoutMs: 200,
  limits: { summaryBytes: 16384, junitBytes: 1024 * 1024, vitestBytes: 1024 * 1024,
    logsArchiveBytes: 65536, logBytes: 8192 } }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verify-repository-'))
  const directory = join(root, 'reports')
  mkdirSync(directory)
  return { root, directory, close: () => rmSync(root, { recursive: true, force: true }) }
}

function receipt(directory, key, code = 0) {
  writeReport(portionPath(directory, key, 'command.json'), { key, code,
    startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:00:01.000Z' }, 8192)
}

test('cold-cache verification recreates private executable scratch directories without using the caller home', () => {
  const f = fixture()
  const scratch = join(f.root, 'scratch')
  const configuration = { ...context(), mutableDirectory: scratch, storeDirectory: join(scratch, 'store') }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const environment = verificationScratchEnvironment(configuration, { ...fixtureGitEnvironment, HOME: '/outside/home' })
      assert.equal(environment.HOME, join(scratch, 'home'))
      assert.equal(environment.TMPDIR, join(scratch, 'tmp'))
      const created = execFileSync(process.execPath, ['-e',
        "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');" +
        "process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-')))"],
      { env: environment, encoding: 'utf8' })
      assert.ok(created.startsWith(join(scratch, 'tmp', 'fixture-')))
      assert.ok(existsSync(environment.XDG_CACHE_HOME))
      rmSync(scratch, { recursive: true })
    }
  } finally { f.close() }
})

test('verification refuses a scratch directory symlink before recreating its caches', () => {
  const f = fixture()
  const scratch = join(f.root, 'scratch')
  try {
    mkdirSync(scratch)
    symlinkSync(f.root, join(scratch, 'tmp'))
    assert.throws(() => verificationScratchEnvironment({ ...context(), mutableDirectory: scratch,
      storeDirectory: join(scratch, 'store') }, fixtureGitEnvironment), /Unsafe report directory/)
  } finally { f.close() }
})

test('private HEAD is checked against its generated receipt while reports retain the approved source commit', () => {
  const f = fixture()
  try {
    const git = (...args) => execFileSync('git', args, { cwd: f.root,
      env: fixtureGitEnvironment, encoding: 'utf8' }).trim()
    git('init', '--quiet')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'private snapshot')
    const configuration = context()
    configuration.privateGit.generatedCommit = git('rev-parse', 'HEAD')
    assert.notEqual(configuration.privateGit.generatedCommit, configuration.identity.commit)
    assert.doesNotThrow(() => verifyPrivateGitHead(f.root, configuration, fixtureGitEnvironment))
    configuration.privateGit.generatedCommit = '0'.repeat(40)
    assert.throws(() => verifyPrivateGitHead(f.root, configuration, fixtureGitEnvironment), /authenticated receipt/)
    configuration.privateGit.sourceCommit = '0'.repeat(40)
    assert.throws(() => validateVerificationContext(configuration), /accepted source commit/)
  } finally { f.close() }
})

test('a reserved empty summary permits launch but prior attempt results and symlinks do not', () => {
  const f = fixture()
  try {
    const directory = join(f.root, '.logs', 'verification')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'summary.json'), '')
    assert.equal(prepareVerificationDirectory(f.root), directory)
    assert.throws(() => prepareVerificationDirectory(f.root), /attempt results/)
    rmSync(directory, { recursive: true })
    mkdirSync(directory)
    symlinkSync(join(f.root, 'reports'), join(directory, 'summary.json'))
    assert.throws(() => prepareVerificationDirectory(f.root), /attempt results/)
  } finally { f.close() }
})

test('ordinary suites run their full root commands', () => {
  for (const [suite, script] of [['typecheck', 'typecheck'], ['lint', 'lint'], ['unit', 'test'], ['build', 'build'], ['integration', 'test:integration']]) {
    assert.deepEqual(verificationCommand(context(suite)), ['corepack', 'pnpm', script])
  }
  const install = { ...context('install'), storeDirectory: '/mutable/store', requiredPortions: [{ key: 'root:install', kind: 'command' }],
  mutableDirectory: '/mutable',
    preseedReceipt: {} }
  assert.deepEqual(verificationCommand(install), ['corepack', 'pnpm', 'install', '--frozen-lockfile',
    '--offline', '--prod=false', '--store-dir', '/mutable/store'])
})

test('missing policy inputs, excessive workers and report reservations fail closed', () => {
  assert.throws(() => validateVerificationContext({}), /context/)
  assert.throws(() => validateVerificationContext({ ...context(), limits: {} }), /positive integer/)
  const tooMany = context()
  tooMany.identity.parameters.unitWorkers = 2
  assert.throws(() => validateVerificationContext(tooMany), /Unit workers/)
  const tooLarge = context()
  tooLarge.identity.resources.reportBytes = 1024
  assert.throws(() => validateVerificationContext(tooLarge), /reservation/)
  assert.throws(() => verificationCommand({ ...context('install'), storeDirectory: undefined }), /private store/)
  assert.throws(() => verificationCommand({ ...context('install'), requiredPortions: [{ key: 'root:install', kind: 'command' }],
  mutableDirectory: '/mutable',
    storeDirectory: '/owner/store', preseedReceipt: {} }), /inside the Job/)
})

test('offline provenance must match lockfile, pnpm, platform and verified release age', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'frozen lockfile')
    const receipt = { lockfileSha256: createHash('sha256').update('frozen lockfile').digest('hex'),
      pnpmVersion: '11.27.0', platform: process.platform, architecture: process.arch,
      provenanceDigest: 'a'.repeat(64), minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true }
    assert.doesNotThrow(() => verifyOfflinePreseed(f.root, receipt))
    for (const change of [{ lockfileSha256: 'b'.repeat(64) }, { pnpmVersion: '11.28.0' },
      { platform: 'unknown' }, { releaseAgeVerified: false }, { minimumReleaseAgeMinutes: 0 }]) {
      assert.throws(() => verifyOfflinePreseed(f.root, { ...receipt, ...change }), /Preseed receipt/)
    }
  } finally { f.close() }
})

test('a native Node test process records each file and case, including skips', async () => {
  const f = fixture()
  try {
    const file = join(f.root, 'example.test.mjs')
    writeFileSync(file, "import { test } from 'node:test'; test('passes', () => {}); test.skip('skips', () => {});\n")
    const code = await runVerificationCommand([process.execPath, '--test', file], {
      root: f.root, cwd: f.root, script: 'test', env: { ...process.env,
        NODE_TEST_CONTEXT: 'child-v8',
        FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory, FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192',
        FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '65536', FOREMAN_CODE_VERIFICATION_UNIT_WORKERS: '1' },
    })
    assert.equal(code, 0)
    const report = readNodeReport(portionPath(f.directory, 'root:test', 'node.ndjson'),
      { root: f.root, expectedFiles: ['example.test.mjs'], maxBytes: 65536 })
    assert.equal(report.complete, true)
    assert.deepEqual(report.totals, { total: 2, passed: 1, failed: 0, skipped: 1 })
  } finally { f.close() }
})

test('exit zero with a missing or corrupt native report is incomplete', () => {
  const f = fixture()
  try {
    const key = 'root:test'
    receipt(f.directory, key)
    writeReport(portionPath(f.directory, key, 'inventory.json'), ['example.test.mjs'], 8192)
    const expected = [{ key, kind: 'vitest' }]
    assert.equal(collectPortions(f.directory, f.root, expected, context().limits)[0].complete, false)
    writeFileSync(portionPath(f.directory, key, 'vitest.json'), '{broken')
    assert.equal(collectPortions(f.directory, f.root, expected, context().limits)[0].complete, false)
    receipt(f.directory, key, 1)
    assert.equal(collectPortions(f.directory, f.root, expected, context().limits)[0].failed, true)
  } finally { f.close() }
})

test('interrupted Node reports retain observed passes even before the command receipt exists', () => {
  const f = fixture()
  try {
    const key = 'root:test'
    writeReport(portionPath(f.directory, key, 'inventory.json'), ['example.test.mjs'], 8192)
    writeFileSync(portionPath(f.directory, key, 'node.ndjson'), JSON.stringify({ type: 'test:pass',
      file: join(f.root, 'example.test.mjs'), name: 'observed', testType: 'test', duration: 1 }) + '\n')
    const portions = collectPortions(f.directory, f.root, [{ key, kind: 'node' }], context().limits)
    assert.equal(portions[0].complete, false)
    assert.equal(portions[0].totals.passed, 1)
  } finally { f.close() }
})

test('finalization emits contract-valid summary, JUnit, Vitest JSON and a binary archive', async () => {
  const f = fixture()
  try {
    receipt(f.directory, 'apps/api:build')
    const log = 'compiler diagnostic: fixture output\n'
    writeFileSync(portionPath(f.directory, 'apps/api:build', 'log'), log)
    const configuration = { ...context('build'), requiredPortions: [{ key: 'apps/api:build', kind: 'command' }] }
    const summary = finalizeVerification(configuration, { root: f.root, directory: f.directory,
      state: { startedAt: new Date(Date.now() - 1000).toISOString(), expected: [{ key: 'apps/api:build', kind: 'command' }] },
      terminalOutcome: 'passed', processStopped: true })
    assert.equal(summary.outcome, 'passed')
    const { JobVerificationReportSchema } = await import('../packages/contracts/dist/jobVerification.js')
    assert.equal(JobVerificationReportSchema.parse(summary).executionId, 'execution')
    for (const file of ['summary.json', 'junit.xml', 'vitest.json', 'logs.tar.gz']) assert.ok(existsSync(join(f.directory, file)))
    assertArchivedLogs(f.root, f.directory, log)
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'vitest.json'), 'utf8')).verification.commit, configuration.identity.commit)
  } finally { f.close() }
})

test('finalization publishes passing, failing and skipped cases in JUnit', () => {
  const f = fixture()
  try {
    const key = 'root:test'
    receipt(f.directory, key, 1)
    writeReport(portionPath(f.directory, key, 'inventory.json'), ['example.test.mjs'], 8192)
    writeReport(portionPath(f.directory, key, 'vitest.json'), {
      success: false, numTotalTestSuites: 1, numPassedTestSuites: 0, numFailedTestSuites: 1,
      numPendingTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1,
      testResults: [{ name: join(f.root, 'example.test.mjs'), status: 'failed', startTime: 0, endTime: 1000,
        assertionResults: [
          { fullName: 'passes & reports', status: 'passed', duration: 100 },
          { fullName: 'fails <clearly>', status: 'failed', failureMessages: ['expected <actual> & failed'] },
          { fullName: 'skips', status: 'pending' },
        ] }],
    }, 8192)
    const configuration = { ...context(), requiredPortions: [{ key, kind: 'vitest' }] }
    const summary = finalizeVerification(configuration, { root: f.root, directory: f.directory,
      state: { startedAt: new Date().toISOString() }, terminalOutcome: 'failed', processStopped: true })
    assert.equal(summary.outcome, 'failed')
    assert.deepEqual(summary.totals, { total: 3, passed: 1, failed: 1, skipped: 1 })
    assertJunitCases(f.directory)
  } finally { f.close() }
})

test('publication limit failure produces an incomplete summary without fabricated successes', () => {
  const f = fixture()
  try {
    receipt(f.directory, 'root:install')
    const configuration = context('install')
    configuration.limits.junitBytes = 1
    const summary = finalizeVerification(configuration, { root: f.root, directory: f.directory,
      state: { startedAt: new Date(Date.now() - 1000).toISOString(), expected: [{ key: 'root:install', kind: 'command' }] },
      terminalOutcome: 'passed', processStopped: true })
    assert.equal(summary.outcome, 'incomplete')
    assert.equal(summary.completeness, 'partial')
    assert.equal(existsSync(join(f.directory, 'junit.xml')), false)
  } finally { f.close() }
})

async function waitForLog(path, text) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes(text)) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Fixture process did not become ready')
}

test('deadline closes a TERM-ignoring process and its detached descendant', async () => {
  const f = fixture()
  try {
    const script = `const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { detached: true, stdio: 'ignore' });
      console.log('child=' + child.pid); setInterval(() => {}, 1000);`
    const result = await runSuiteProcess([process.execPath, '-e', script], { root: f.root, env: process.env,
      directory: f.directory, limits: context().limits, executionTimeoutMs: 500, cancellationTimeoutMs: 100 })
    const childPid = Number(readFileSync(join(f.directory, 'parts', 'root.log'), 'utf8').match(/child=(\d+)/)[1])
    assert.equal(result.terminalOutcome, 'timed_out')
    assert.equal(result.processStopped, true)
    assert.equal(groupUsed(childPid), false)
  } finally { f.close() }
})

test('cancellation preserves bounded output and closes the active group', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    const pending = runSuiteProcess([process.execPath, '-e',
      "console.log('ready'); process.stdout.write('x'.repeat(30000)); setInterval(() => {}, 1000)"],
    { root: f.root, env: process.env, directory: f.directory, limits: context().limits,
      executionTimeoutMs: 3000, cancellationTimeoutMs: 100, signal: controller.signal })
    await waitForLog(join(f.directory, 'parts', 'root.log'), 'ready')
    controller.abort()
    const result = await pending
    assert.equal(result.terminalOutcome, 'cancelled')
    assert.equal(result.processStopped, true)
    assert.ok(result.log.discardedBytes > 0)
    assert.equal(result.log.bytes, context().limits.logBytes)
  } finally { controller.abort(); f.close() }
})

test('an already cancelled request never starts its command', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  try {
    const marker = join(f.root, 'should-not-run')
    const result = await runSuiteProcess([process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    { root: f.root, env: process.env, directory: f.directory, limits: context().limits,
      executionTimeoutMs: 2000, cancellationTimeoutMs: 100, signal: controller.signal })
    assert.equal(result.terminalOutcome, 'cancelled')
    assert.equal(existsSync(marker), false)
  } finally { f.close() }
})

test('unit inventory includes all package runners and both web/root smoke commands', () => {
  const portions = expectedPortions(new URL('..', import.meta.url).pathname, 'unit')
  assert.deepEqual(portions.map(({ key }) => key), ['root:install', 'root:worker-artifact', 'packages/contracts:test', 'apps/api:test',
    'apps/web:test:unit', 'apps/web:test:run-graph-smoke', 'apps/worker:test', 'root:test:scripts'])
})


test('measurement reads available cgroup metrics and denies missing or corrupt metrics', t => {
  const f = fixture()
  try {
    const cgroup = join(f.root, 'cgroup')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cpu.stat'), 'usage_usec 12345\n')
    writeFileSync(join(cgroup, 'memory.peak'), '65536\n')
    writeFileSync(join(cgroup, 'pids.peak'), '4\n')
    const input = { mutableDirectory: f.root, cgroupDirectory: cgroup }
    const statfs = t.mock.method(fs, 'statfsSync')
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    const measurement = sampleVerificationResources(input)
    assert.equal(statfs.mock.callCount(), 1)
    // Compare the kernel snapshot consumed by the sampler, which other writers cannot change afterward.
    const filesystem = statfs.mock.calls[0].result
    assert.equal(measurement.mutableBytes, (filesystem.blocks - filesystem.bfree) * filesystem.bsize)
    assert.equal(measurement.mutableInodes, filesystem.files - filesystem.ffree)
    assert.equal(measurement.cpuUsageUsec, 12345)
    assert.equal(measurement.memoryPeakBytes, 65536)
    assert.equal(measurement.pidsPeak, 4)
    writeFileSync(join(cgroup, 'pids.peak'), 'unknown\n')
    assert.throws(() => sampleVerificationResources(input), /unavailable or invalid/)
    rmSync(join(cgroup, 'pids.peak'))
    assert.throws(() => sampleVerificationResources(input))
  } finally { f.close() }
})


test('a failed bootstrap is required for completeness without inventing unit cases', () => {
  const f = fixture()
  try {
    receipt(f.directory, 'root:install', 1)
    const portions = collectPortions(f.directory, f.root, [
      { key: 'root:install', kind: 'bootstrap' }, { key: 'apps/api:test', kind: 'vitest' },
    ], context().limits)
    assert.equal(portions[0].failed, true)
    assert.equal(portions[0].totals.total, 0)
    const summary = suiteSummary(context().identity, portions, { startedAt: new Date(0).toISOString(),
      finishedAt: new Date().toISOString(), terminalOutcome: 'failed', processStopped: true })
    assert.equal(summary.outcome, 'incomplete')
    assert.equal(summary.firstPassFailed, 1)
    assert.equal(summary.completedPortions, 1)
    assert.equal(summary.expectedPortions, 2)
    assert.equal(summary.totals.total, 0)
  } finally { f.close() }
})


test('unit completeness includes exact-source worker packaging without counting it as test cases', () => {
  const f = fixture()
  try {
    const expected = expectedPortions(new URL('..', import.meta.url).pathname, 'unit')
    const packaging = expected.find(portion => portion.key === 'root:worker-artifact')
    assert.equal(packaging.kind, 'bootstrap')
    const missing = collectPortions(f.directory, f.root, [packaging], context().limits)[0]
    assert.equal(missing.complete, false)
    receipt(f.directory, packaging.key)
    const complete = collectPortions(f.directory, f.root, [packaging], context().limits)[0]
    assert.equal(complete.complete, true)
    assert.equal(complete.totals.total, 0)
  } finally { f.close() }
})


test('integration inventory requires every API integration file and no acceptance or unit tests', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'foreman-code' }))
    mkdirSync(join(f.root, 'apps/api/test'), { recursive: true })
    for (const name of ['one.integration.test.ts', 'two.integration.test.ts', 'unit.test.ts', 'native.acceptance.test.ts']) {
      writeFileSync(join(f.root, 'apps/api/test', name), '')
    }
    const inventory = captureVerificationInventory(f.root, 'integration')
    assert.deepEqual(inventory, [
      { key: 'root:install', kind: 'bootstrap' },
      { key: 'packages/contracts:build', kind: 'command' },
      { key: 'root:test:integration', kind: 'integration', files: [
        'apps/api/test/one.integration.test.ts', 'apps/api/test/two.integration.test.ts',
      ] },
    ])
  } finally { f.close() }
})

test('integration collection preserves first-pass failures and refuses incomplete file coverage', () => {
  const f = fixture()
  const key = 'root:test:integration'
  const file = 'apps/api/test/example.integration.test.ts'
  const reportDirectory = join(f.directory, 'parts/integration')
  try {
    receipt(f.directory, key)
    const totals = { total: 1, passed: 1, failed: 0, skipped: 0 }
    const summary = { schemaVersion: 1, suite: 'integration', expectedPortions: 1, completedPortions: 1,
      completeness: 'complete', outcome: 'passed', totals, firstPassFailed: 0, disallowedSkipped: 0,
      files: [{ file, code: 0, complete: true, totals }] }
    writeReport(join(reportDirectory, 'summary.json'), summary, 65536)
    writeReport(join(reportDirectory, 'vitest.json'), { success: true, numTotalTests: 1, numPassedTests: 1,
      numFailedTests: 0, numPendingTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 1,
      numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: [{ name: join(f.root, file), status: 'passed', startTime: 1, endTime: 2,
        assertionResults: [{ title: 'works', fullName: 'works', status: 'passed', failureMessages: [] }] }] }, 65536)
    const portions = [{ key, kind: 'integration', files: [file] }]
    assert.equal(collectPortions(f.directory, f.root, portions, context().limits)[0].complete, true)
    assert.equal(collectPortions(f.directory, f.root, portions, context().limits)[0].failed, false)
    writeReport(join(reportDirectory, 'summary.json'), { ...summary, outcome: 'failed', firstPassFailed: 1 }, 65536)
    assert.equal(collectPortions(f.directory, f.root, portions, context().limits)[0].failed, true)
    writeReport(join(reportDirectory, 'summary.json'), { ...summary, files: [] }, 65536)
    assert.equal(collectPortions(f.directory, f.root, portions, context().limits)[0].complete, false)
  } finally { f.close() }
})

test('qualification runs the committed integration smoke subset while CI Jobs run the whole suite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'integration-qualification-'))
  try {
    mkdirSync(join(root, 'apps/api/test'), { recursive: true })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foreman-code' }))
    const all = ['a', 'b', 'c'].map(name => `apps/api/test/${name}.integration.test.ts`)
    for (const file of all) writeFileSync(join(root, file), '')
    const inventory = options => captureVerificationInventory(root, 'integration', options)
      .find(portion => portion.kind === 'integration').files
    assert.deepEqual(inventory({ qualification: true }), all)
    writeFileSync(join(root, 'scripts/integration-qualification.json'), JSON.stringify({ files: [all[1]] }))
    assert.deepEqual(inventory(), all)
    assert.deepEqual(inventory({ qualification: true }), [all[1]])
    const integration = files => ({ ...context('integration'), requiredPortions: [{ key: 'root:install', kind: 'bootstrap' },
      { key: 'root:test:integration', kind: 'integration', files }] })
    assert.deepEqual(verificationCommand(integration([all[1]]), root),
      ['corepack', 'pnpm', 'test:integration', '--files', all[1]])
    assert.deepEqual(verificationCommand(integration(all), root), ['corepack', 'pnpm', 'test:integration'])
    writeFileSync(join(root, 'scripts/integration-qualification.json'), JSON.stringify({ files: ['apps/api/test/gone.integration.test.ts'] }))
    assert.throws(() => inventory({ qualification: true }), /must list existing integration test files/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a partitioned CI Job runs one duration-balanced slice and the slices cover every file once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'integration-partition-'))
  try {
    mkdirSync(join(root, 'apps/api/test'), { recursive: true })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foreman-code' }))
    const durations = { long: 600, mid: 300, short: 100, tiny: 50, other: 250 }
    const all = Object.keys(durations).map(name => `apps/api/test/${name}.integration.test.ts`).sort()
    for (const file of all) writeFileSync(join(root, file), '')
    writeFileSync(join(root, 'scripts/ci-learned-durations.json'), JSON.stringify(Object.fromEntries(
      Object.entries(durations).map(([name, ms]) => [`apps/api/test/${name}.integration.test.ts`, ms]))))
    const slice = index => captureVerificationInventory(root, 'integration', { partition: { index, count: 2 } })
      .find(portion => portion.kind === 'integration').files
    const [first, second] = [slice(0), slice(1)]
    assert.deepEqual([...first, ...second].sort(), all)
    assert.equal(first.filter(file => second.includes(file)).length, 0)
    const time = files => files.reduce((total, file) => total + durations[file.split('/').at(-1).split('.')[0]], 0)
    assert.ok(Math.abs(time(first) - time(second)) <= 100, `${time(first)} vs ${time(second)}`)
    assert.deepEqual(slice(0), first)
    const integration = files => ({ ...context('integration'), requiredPortions: [{ key: 'root:install', kind: 'bootstrap' },
      { key: 'root:test:integration', kind: 'integration', files }] })
    assert.deepEqual(verificationCommand(integration(first), root), ['corepack', 'pnpm', 'test:integration', '--files', ...first])
    // Files without a recorded duration still land in exactly one slice.
    writeFileSync(join(root, 'apps/api/test/new.integration.test.ts'), '')
    const covered = [...slice(0), ...slice(1)]
    assert.equal(covered.filter(file => file.endsWith('/new.integration.test.ts')).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
