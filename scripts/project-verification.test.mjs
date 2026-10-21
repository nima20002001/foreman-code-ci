import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { captureVerificationInventory } from './verification-runner.mjs'

const runner = fileURLToPath(new URL('./verify-repository.mjs', import.meta.url))
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

function fixture(t, scripts) {
  const root = mkdtempSync(join(tmpdir(), 'project-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repository = join(root, 'project')
  const bin = join(root, 'bin')
  mkdirSync(repository)
  mkdirSync(bin)
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'ordinary-project',
    packageManager: 'pnpm@11.27.0', scripts }))
  writeFileSync(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(repository, 'check.mjs'), "console.log('project command ran');\n")
  writeFileSync(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'pnpm') process.exit(9);
if (args[1] === '--version') console.log('11.27.0');
else if (args[1] === 'config') {
  const policy = { minimumReleaseAge: '2880', minimumReleaseAgeStrict: 'true',
    minimumReleaseAgeIgnoreMissingTime: 'false', minimumReleaseAgeExclude: '[]' };
  console.log(policy[args[3]]);
} else if (args[1] === 'install') {
  if (!args.includes('--offline') || !args.includes('--frozen-lockfile')) process.exit(8);
} else {
  const script = JSON.parse(fs.readFileSync('package.json')).scripts?.[args[1]];
  if (!script) { console.error('Missing script: ' + args[1]); process.exit(1); }
  const result = spawnSync('/bin/sh', ['-c', script], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`, { mode: 0o700 })
  const git = (...args) => execFileSync('git', args, { cwd: repository, env: cleanEnvironment, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'project')
  return { root, repository, bin, commit: git('rev-parse', 'HEAD') }
}

function runProject(f, suite) {
  const digest = 'a'.repeat(64)
  const context = {
    identity: { suite, commit: f.commit, manifestDigest: digest, definitionVersionId: 'definition',
      executionId: 'execution', attemptId: 'attempt', target: {}, profile: {},
      resources: { reportBytes: 4 * 2 ** 20 }, parameters: { unitWorkers: 1, integrationShards: 1 } },
    privateGit: { sourceCommit: f.commit, generatedCommit: f.commit, repositoryReceiptDigest: digest,
      configDigest: digest, indexDigest: digest },
    requiredPortions: captureVerificationInventory(f.repository, suite),
    mutableDirectory: join(f.root, 'scratch'), storeDirectory: join(f.root, 'scratch/store'),
    preseedReceipt: { lockfileSha256: createHash('sha256').update(readFileSync(join(f.repository, 'pnpm-lock.yaml'))).digest('hex'),
      pnpmVersion: '11.27.0', platform: process.platform, architecture: process.arch,
      provenanceDigest: digest, minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true },
    qualifiedUnitWorkers: 1, qualifiedIntegrationShards: 1, executionTimeoutMs: 10_000, cancellationTimeoutMs: 200,
    limits: { summaryBytes: 16384, junitBytes: 2 ** 20, vitestBytes: 2 ** 20, logsArchiveBytes: 65536, logBytes: 8192 },
  }
  const contextPath = join(f.root, 'context.json')
  writeFileSync(contextPath, JSON.stringify(context))
  const result = spawnSync(process.execPath, [runner, '--context', contextPath], { cwd: f.repository,
    env: { ...cleanEnvironment, PATH: `${f.bin}:${cleanEnvironment.PATH}` }, encoding: 'utf8', timeout: 15_000 })
  const reports = join(f.repository, '.logs/verification')
  const summary = JSON.parse(readFileSync(join(reports, 'summary.json'), 'utf8'))
  return { result, summary, reports }
}

for (const [suite, script] of [['build', 'build'], ['lint', 'lint'], ['unit', 'test']]) {
  test(`ordinary project ${suite} reports its root script without Foreman packages`, t => {
    const f = fixture(t, { [script]: 'node check.mjs' })
    assert.deepEqual(captureVerificationInventory(f.repository, suite), [
      { key: 'root:install', kind: 'bootstrap' }, { key: `root:${script}`, kind: 'command' },
    ])
    const { result, summary, reports } = runProject(f, suite)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(summary.outcome, 'passed')
    assert.equal(summary.completeness, 'complete')
    assert.deepEqual(summary.totals, { total: 1, passed: 1, failed: 0, skipped: 0 })
    assert.match(readFileSync(join(reports, 'parts/root.log'), 'utf8'), /project command ran/)
    for (const name of ['junit.xml', 'vitest.json', 'logs.tar.gz']) assert.ok(readFileSync(join(reports, name)).length > 0)
  })
}

test('a missing root script is a failed command with retained logs', t => {
  const f = fixture(t, {})
  const { result, summary, reports } = runProject(f, 'build')
  assert.equal(result.status, 1)
  assert.equal(summary.outcome, 'failed')
  assert.equal(summary.totals.failed, 1)
  assert.match(readFileSync(join(reports, 'parts/root.log'), 'utf8'), /Missing script: build/)
})

test('a failing project cannot replace its command outcome with a passing report', t => {
  const f = fixture(t, { test: 'node fail.mjs' })
  writeFileSync(join(f.repository, 'fail.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync('.logs/verification/parts/root_test.command.json', JSON.stringify({
key: 'root:test', code: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
process.exit(7);`)
  const { result, summary } = runProject(f, 'unit')
  assert.equal(result.status, 1)
  assert.equal(summary.outcome, 'failed')
  assert.equal(summary.totals.passed, 0)
  assert.equal(summary.totals.failed, 1)
})

for (const exitCode of [0, 7]) {
  test(`Foreman integration retains its actual command outcome ${exitCode} with complete test reports`, t => {
    const f = fixture(t, { 'test:integration': 'node integration.mjs' })
    const manifest = JSON.parse(readFileSync(join(f.repository, 'package.json'), 'utf8'))
    writeFileSync(join(f.repository, 'package.json'), JSON.stringify({ ...manifest, name: 'foreman-code' }))
    const file = 'apps/api/test/example.integration.test.ts'
    mkdirSync(join(f.repository, 'apps/api/test'), { recursive: true })
    writeFileSync(join(f.repository, file), '')
    writeFileSync(join(f.repository, 'integration.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = join(process.env.FOREMAN_CODE_VERIFICATION_REPORT_DIR, 'parts');
const output = join(directory, 'integration');
mkdirSync(output, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(directory, 'packages_contracts_build.command.json'), JSON.stringify({
  key: 'packages/contracts:build', code: 0, startedAt: now, finishedAt: now,
}));
const file = ${JSON.stringify(file)};
const totals = { total: 1, passed: 1, failed: 0, skipped: 0 };
writeFileSync(join(output, 'summary.json'), JSON.stringify({ schemaVersion: 1, suite: 'integration',
  expectedPortions: 1, completedPortions: 1, completeness: 'complete', outcome: 'passed', totals,
  firstPassFailed: 0, disallowedSkipped: 0, files: [{ file, code: 0, complete: true, totals }],
}));
writeFileSync(join(output, 'vitest.json'), JSON.stringify({ success: true,
  numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
  numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: join(process.cwd(), file), status: 'passed', startTime: 1, endTime: 2,
    assertionResults: [{ title: 'works', fullName: 'works', status: 'passed', failureMessages: [] }] }],
}));
process.exit(${exitCode});`)
    const { result, summary } = runProject(f, 'integration')
    assert.equal(summary.completeness, 'complete')
    assert.equal(summary.outcome, exitCode === 0 ? 'passed' : 'failed')
    assert.equal(summary.firstPassFailed, Number(exitCode !== 0))
    assert.equal(result.status, exitCode === 0 ? 0 : 1, result.stderr)
    assert.equal(summary.completedPortions, summary.expectedPortions)
  })
}
