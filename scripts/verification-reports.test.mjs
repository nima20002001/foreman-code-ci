import { assertArchivedLogs, assertJunitCases } from './test-support/verificationExports.mjs'
import { integrationEnvironmentCapabilities, partitionUnitCapabilities } from './integration-capabilities.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { groupUsed } from './integration-process.mjs'
import { collectPortions, expectedPortions, finalizeVerification, runSuiteProcess,
  validateVerificationContext, verificationCommand, verifyOfflinePreseed } from './verify-repository.mjs'
import { portionPath, readNodeReport, runVerificationCommand, writeReport } from './verification-reports.mjs'

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
  mutableDirectory: '/mutable', storeDirectory: '/mutable/store', preseedReceipt: {}, qualifiedUnitWorkers: 1, executionTimeoutMs: 2000, cancellationTimeoutMs: 200,
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

test('ordinary suites run their full root commands', () => {
  for (const [suite, script] of [['typecheck', 'typecheck'], ['lint', 'lint'], ['unit', 'test'], ['build', 'build']]) {
    assert.deepEqual(verificationCommand(context(suite)), ['corepack', 'pnpm', script])
  }
  const install = { ...context('install'), storeDirectory: '/mutable/store', requiredPortions: [{ key: 'root:install', kind: 'command' }],
  mutableDirectory: '/mutable',
    preseedReceipt: {} }
  assert.deepEqual(verificationCommand(install), ['corepack', 'pnpm', 'install', '--frozen-lockfile',
    '--offline', '--prod=false', '--store-dir', '/mutable/store'])
})

test('unit package commands honor configured worker limits and local defaults', t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'unit-worker-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'vitest'), `#!${process.execPath}
    (async () => {
      const { createRequire } = await import('node:module')
      const { pathToFileURL } = await import('node:url')
      const project = process.cwd()
      const require = createRequire(project + '/package.json')
      const { parseCLI, resolveConfig } = await import(pathToFileURL(require.resolve('vitest/node')))
      const { options } = parseCLI(['vitest', ...process.argv.slice(2)])
      const config = await resolveConfig({ ...options, root: project })
      console.log(JSON.stringify({ phase: process.env.FOREMAN_WEB_TEST_PHASE ?? null,
        maxWorkers: config.test.maxWorkers }))
    })().catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  `, { mode: 0o755 })
  const wrapper = new URL('./ci-remote.mjs', import.meta.url).pathname
  const projects = [
    ['apps/api', 'test', [{ phase: null, maxWorkers: 4 }]],
    ['apps/web', 'test:unit', [{ phase: 'fast', maxWorkers: 4 }, { phase: 'heavy', maxWorkers: 4 }]],
    ['packages/contracts', 'test', [{ phase: null, maxWorkers: 12 }]],
  ]
  for (const [project, script, defaults] of projects) {
    const cwd = join(new URL('..', import.meta.url).pathname, project)
    const { scripts } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    // Run the test payload through CI's wrapper; the probe resolves config without running test files.
    const command = scripts[script].split(' -- ').at(-1)
    for (const configuredWorkers of [undefined, '1', '8']) {
      const env = { ...process.env, CI: 'true', PATH: `${directory}:${process.env.PATH}` }
      delete env.FOREMAN_WEB_TEST_PHASE
      if (configuredWorkers === undefined) delete env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
      else env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS = configuredWorkers
      const output = execFileSync(process.execPath, [wrapper, 'unit', '--', 'sh', '-c', command],
        { cwd, env, encoding: 'utf8' })
      const expected = defaults.map(({ phase, maxWorkers }) => {
        if (configuredWorkers === undefined) return { phase, maxWorkers }
        const workers = Number(configuredWorkers)
        return { phase, maxWorkers: phase === 'heavy' ? Math.min(workers, maxWorkers) : workers }
      })
      assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line)), expected, project)
    }
  }
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
        FOREMAN_CODE_VERIFICATION_COMMAND_KEY: '',
        NODE_TEST_CONTEXT: 'child-v8',
        FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory, FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192',
        FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '65536' },
    })
    assert.equal(code, 0)
    const report = readNodeReport(portionPath(f.directory, 'root:test', 'node.ndjson'),
      { root: f.root, expectedFiles: ['example.test.mjs'], maxBytes: 65536 })
    assert.equal(report.complete, true)
    assert.deepEqual(report.totals, { total: 2, passed: 1, failed: 0, skipped: 1 })
  } finally { f.close() }
})

test('nested builds retain the outer report and allocate separate reports for repeated commands', async () => {
  const f = fixture()
  try {
    const env = { ...process.env, FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory,
      FOREMAN_CODE_VERIFICATION_COMMAND_KEY: '',
      FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192', FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '65536' }
    const options = { root: f.root, cwd: f.root, script: 'build', env }
    assert.equal(await runVerificationCommand([process.execPath, '-e', 'console.log("outer build")'], options), 0)
    const outer = readFileSync(portionPath(f.directory, 'root:build', 'command.json'), 'utf8')
    const module = new URL('./verification-reports.mjs', import.meta.url).href
    const script = `import { runVerificationCommand } from ${JSON.stringify(module)};
      for (let index = 0; index < 2; index++) {
        const code = await runVerificationCommand([process.execPath, '-e', 'console.log("nested build")'],
          { root: process.cwd(), cwd: process.cwd(), script: 'build', env: process.env });
        if (code) process.exit(code);
      }`
    assert.equal(await runVerificationCommand([process.execPath, '--input-type=module', '-e', script],
      { ...options, script: 'test' }), 0)
    assert.equal(readFileSync(portionPath(f.directory, 'root:build', 'command.json'), 'utf8'), outer)
    const nested = readdirSync(f.directory).filter(name => name.startsWith('nested-'))
    assert.equal(nested.length, 2)
    for (const name of nested) {
      const receipt = JSON.parse(readFileSync(portionPath(join(f.directory, name), 'root:build', 'command.json')))
      assert.equal(receipt.code, 0)
      assert.match(readFileSync(portionPath(join(f.directory, name), 'root:build', 'log'), 'utf8'), /nested build/)
    }
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


test('complete Node reports reconcile case totals and preserve nested names', () => {
  const f = fixture()
  try {
    const directory = f.directory
    const path = join(directory, 'node.ndjson')
    const file = '/source/a.test.mjs'
    const counts = { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }
    const events = [
      { type: 'test:start', file, name: 'suite', nesting: 0, timestamp: 1 },
      { type: 'test:start', file, name: 'case', nesting: 1, timestamp: 2 },
      { type: 'test:pass', file, name: 'case', nesting: 1, timestamp: 3, duration: 1 },
      { type: 'test:pass', file, name: 'suite', nesting: 0, timestamp: 4, testType: 'suite' },
      { type: 'test:summary', file, success: true, timestamp: 5, counts },
      { type: 'test:summary', success: true, counts },
    ]
    const read = () => readNodeReport(path, { root: '/source', expectedFiles: ['a.test.mjs'], maxBytes: 4096 })
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const report = read()
    assert.equal(report.complete, true)
    assert.equal(report.totals.passed, 1)
    assert.equal(report.files[0].assertionResults[0].fullName, 'suite > case')
    events.at(-1).counts = { ...counts, failed: 1 }
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    assert.equal(read().complete, false)
  } finally { f.close() }
})

for (const name of ['native-guardian-outcome', 'native-launch-abandonment', 'native-process-ownership',
  'native-response-recovery', 'codex-idle-recovery', 'native-qualification-command-lifecycle', 'codex-protocol']) {
  test(`unit capability scheduling retains required ${name} coverage`, async () => {
    const file = `apps/api/test/${name}.test.ts`
    const environment = await integrationEnvironmentCapabilities({
      FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
    })
    const files = [file, 'apps/api/test/native-command-guardian-memory.test.ts']
    assert.deepEqual(partitionUnitCapabilities(files, environment), { runnable: files, unavailable: [] })
    const unavailableEnvironment = { ...environment,
      capabilities: { ...environment.capabilities, nativeCgroupDelegation: false } }
    const partition = partitionUnitCapabilities(files, unavailableEnvironment)
    assert.deepEqual(partition.runnable, ['apps/api/test/native-command-guardian-memory.test.ts'])
    assert.deepEqual(partition.unavailable.map(entry => entry.file), [file])
    assert.deepEqual(partition.unavailable[0].requiredCapabilities, ['nativeCgroupDelegation'])
    assert.equal(partition.unavailable[0].complete, false)
    assert.equal(partition.unavailable[0].code, null)
  })
}

test('unit runner executes guarded native coverage in the delegated Job and publishes complete totals', async () => {
  const f = fixture()
  try {
    const key = 'apps/api:test'
    const cwd = join(f.root, 'apps/api')
    const bin = join(f.root, 'bin')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(bin)
    const files = ['apps/api/test/native-guardian-outcome.test.ts',
      'apps/api/test/native-command-guardian-memory.test.ts']
    writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const files = ${JSON.stringify(files.map(file => join(f.root, file)))};
if (args[0] === 'list') {
  fs.writeFileSync(args.find(arg => arg.startsWith('--json=')).slice(7), JSON.stringify(files.map(file => ({file}))));
} else {
  assert.equal(args.includes('--exclude'), false);
  fs.writeFileSync(args.find(arg => arg.startsWith('--outputFile.json=')).slice(18), JSON.stringify({
    success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0,
    numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: files.map(name => ({name, status: 'passed', startTime: 1, endTime: 2,
      assertionResults: [{fullName: 'guarded child finishes', status: 'passed', duration: 1, failureMessages: []}]}))
  }));
}
`, { mode: 0o755 })
    const code = await runVerificationCommand(['vitest', 'run'], {
      root: f.root, cwd, script: 'test', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
        FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory,
        FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192', FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '1048576' },
    })
    assert.equal(code, 0)
    const [portion] = collectPortions(f.directory, f.root,
      [{ key, kind: 'vitest', files }], context().limits)
    assert.equal(portion.complete, true)
    assert.deepEqual(portion.unavailable, [])
    assert.deepEqual(portion.totals, { total: 2, passed: 2, failed: 0, skipped: 0 })
  } finally { f.close() }
})

test('explicit unavailable unit selection returns nonzero and retains incomplete diagnostics without cases', async () => {
  const f = fixture()
  try {
    const key = 'apps/api:test'
    const cwd = join(f.root, 'apps/api')
    mkdirSync(cwd, { recursive: true })
    const bin = join(f.root, 'bin')
    mkdirSync(bin)
    const file = 'apps/api/test/native-guardian-outcome.test.ts'
    writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'list') throw new Error('Unavailable native test must not launch');
fs.writeFileSync(args.find(arg => arg.startsWith('--json=')).slice(7), JSON.stringify([{file: ${JSON.stringify(join(f.root, file))}}]));
`, { mode: 0o755 })
    const code = await runVerificationCommand(['vitest', 'run', 'test/native-guardian-outcome.test.ts'], {
      environmentCapabilities: async env => {
        const environment = await integrationEnvironmentCapabilities(env)
        return { ...environment, capabilities: { ...environment.capabilities, nativeCgroupDelegation: false } }
      },
      root: f.root, cwd, script: 'test', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
        FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory,
        FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192', FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '1048576' },
    })
    assert.equal(code, 1)
    assert.deepEqual(JSON.parse(readFileSync(portionPath(f.directory, key, 'inventory.json'))), [file])
    const configuration = context()
    configuration.requiredPortions = [{ key, kind: 'vitest', files: [file] }]
    const portions = collectPortions(f.directory, f.root, configuration.requiredPortions, configuration.limits)
    assert.equal(portions[0].unavailable[0].file, file)
    assert.deepEqual(portions[0].totals, { total: 0, passed: 0, failed: 0, skipped: 0 })
    const summary = finalizeVerification(configuration, { root: f.root, directory: f.directory,
      state: { startedAt: new Date().toISOString() }, terminalOutcome: 'failed', processStopped: true })
    assert.equal(summary.outcome, 'incomplete')
    assert.equal(summary.completeness, 'partial')
    const details = JSON.parse(readFileSync(join(f.directory, 'parts/portions.json')))
    assert.equal(details.portions[0].unavailable[0].file, file)
  } finally { f.close() }
})

test('unit runner executes available files while retaining unavailable coverage and observed totals', async () => {
  const f = fixture()
  try {
    const key = 'apps/api:test'
    const cwd = join(f.root, 'apps/api')
    mkdirSync(cwd, { recursive: true })
    const bin = join(f.root, 'bin')
    mkdirSync(bin)
    const unavailable = 'apps/api/test/native-guardian-outcome.test.ts'
    const available = 'apps/api/test/native-command-guardian-memory.test.ts'
    writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args[0] === 'list') {
  fs.writeFileSync(args.find(arg => arg.startsWith('--json=')).slice(7), JSON.stringify(
    ${JSON.stringify([join(f.root, unavailable), join(f.root, available)])}.map(file => ({file}))));
} else {
  assert.equal(args[args.indexOf('--exclude') + 1], 'test/native-guardian-outcome.test.ts');
  fs.writeFileSync(args.find(arg => arg.startsWith('--outputFile.json=')).slice(18), JSON.stringify({
    success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0,
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{name: ${JSON.stringify(join(f.root, available))}, status: 'passed', startTime: 1, endTime: 2,
      assertionResults: [{fullName: 'mock guardian succeeds', status: 'passed', duration: 1, failureMessages: []}]}]
  }));
}
`, { mode: 0o755 })
    const code = await runVerificationCommand(['vitest', 'run'], {
      environmentCapabilities: async env => {
        const environment = await integrationEnvironmentCapabilities(env)
        return { ...environment, capabilities: { ...environment.capabilities, nativeCgroupDelegation: false } }
      },
      root: f.root, cwd, script: 'test', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
        FOREMAN_CODE_VERIFICATION_REPORT_DIR: f.directory,
        FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192', FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '1048576' },
    })
    assert.equal(code, 1)
    const [portion] = collectPortions(f.directory, f.root,
      [{ key, kind: 'vitest', files: [unavailable, available] }], context().limits)
    assert.equal(portion.error, undefined)
    assert.equal(portion.failed, false)
    assert.equal(portion.complete, false)
    assert.deepEqual(portion.totals, { total: 1, passed: 1, failed: 0, skipped: 0 })
    assert.deepEqual(portion.missing, [unavailable])
    assert.equal(portion.unavailable[0].file, unavailable)
  } finally { f.close() }
})
