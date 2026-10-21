import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { integrationPartition } from '@foreman-code/contracts'
import { compactIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { repositoryFileList, selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { fixture } from './cloud.testSupport.js'
import { cloudSuiteRunner } from './cloudRunner.testSupport.js'

const parameter = (args: string[], name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)

it.each(['github', 'circleci'] as const)('uses source coverage across the synthetic %s mirror history', async provider => {
  const f = await fixture({}, { provider })
  const source = 'apps/api/test/feature.ts'
  const other = 'apps/api/test/other.ts'
  const files = ['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)
  await f.write(source, 'export const value = 1')
  await f.write(other, 'export const other = 2')
  await f.write('apps/api/test/bootstrap.ts', "import './feature.js'; import './other.js'")
  for (const file of files.slice(0, 2)) await f.write(file, "import './bootstrap.js'")
  f.run('add', '.')
  f.run('commit', '-qm', 'coverage baseline')
  const baseCommit = f.run('rev-parse', 'HEAD')
  const coverage = { version: 1 as const, commit: baseCommit, testFiles: files,
    coverage: { [files[0]!]: [source], [files[1]!]: [other], [files[2]!]: [], [files[3]!]: [] } }
  await f.write(source, 'export const value = 3')
  f.run('commit', '-qam', 'feature change')
  f.push('main')
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.run('rev-parse', 'HEAD'), baseCommit,
    suite: 'integration', scope: 'affected', integrationCoverage: {
      map: gzipSync(JSON.stringify(compactIntegrationCoverage(coverage))).toString('base64'), changedFiles: [source],
    } })
  const command = (provider === 'circleci' ? f.circle.triggered : f.dispatched)[0]!
  const checkout = await f.checkoutMirror(command[command.indexOf(provider === 'circleci' ? '--branch' : '--ref') + 1]!)
  const suite = await cloudSuiteRunner(checkout, command, provider)
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', files[0]]])
  expect(result.stderr).toContain(baseCommit)
})

it.each(['unit', 'integration'] as const)('isolates the %s suite fixture from enclosing CI shell startup', async suite => {
  const file = `apps/api/test/selected.${suite === 'integration' ? 'integration.' : ''}test.ts`
  const f = await fixture({ [file]: '' }, { provider: 'circleci' })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite, scope: 'affected', files: [file] })
  const command = f.circle.triggered[0]!
  const checkout = await f.checkoutMirror(command[command.indexOf('--branch') + 1]!)
  const runner = await cloudSuiteRunner(checkout, command, 'circleci')
  const startup = join(f.root, 'shell-startup')
  await writeFile(startup, 'export PATH=/unavailable-fixture-commands\n')
  vi.stubEnv('BASH_ENV', startup)
  try {
    const result = runner.run()
    expect(result.status, result.stderr).toBe(0)
    const calls = (await readFile(runner.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toEqual(suite === 'integration' ? [['pnpm', 'test:integration', '--files', file]] : [
      ['pnpm', '--filter', '@foreman-code/contracts', 'build'],
      ['--', 'corepack', 'pnpm', '--dir', 'apps/api', 'exec', 'vitest', 'run', file.slice('apps/api/'.length)],
    ])
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(['github', 'circleci'] as const)('runs an oversized partition on %s with its complete file list', async provider => {
  const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(3, '0')}.integration.test.ts`)
  const f = await fixture(Object.fromEntries(files.map(file => [file, ''])), { provider })
  const partition = { index: 0, count: 2, tier: 'slow' as const, slowFiles: files, weights: [2, 1] }
  expect(JSON.stringify(partition).length).toBeGreaterThan(500)
  const runId = randomUUID()
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration', partition })
  expect(reply).toMatchObject({ run: { state: provider === 'github' ? 'starting' : 'running' } })
  const command = (provider === 'circleci' ? f.circle.triggered : f.dispatched)[0]!
  if (provider === 'circleci') {
    for (const value of command.filter(value => value.includes('='))) {
      expect(value.slice(value.indexOf('=') + 1).length).toBeLessThanOrEqual(500)
    }
  }
  const ref = command[command.indexOf(provider === 'circleci' ? '--branch' : '--ref') + 1]!
  const checkout = await f.checkoutMirror(ref)
  const suite = await cloudSuiteRunner(checkout, command, provider)
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...integrationPartition(files, {}, partition)]])
  if (provider === 'circleci') {
    expect(f.mirrorGit('rev-parse', ref)).toBe(reply.operation === 'start' ? reply.run.provenance?.workflowCommit : '')
    expect(f.mirrorGit('ls-tree', '--name-only', 'main')).not.toContain('ci-dispatch-inputs.json')
    const manifest = join(checkout, 'ci-dispatch-inputs.json')
    const data = await readFile(manifest)
    expect(parameter(command, 'partition')).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`)
    await writeFile(suite.calls, '')
    await writeFile(manifest, `${data.toString()} `)
    const corrupted = suite.run()
    expect(corrupted.status).not.toBe(0)
    expect(corrupted.stderr).toContain('CI dispatch inputs hash mismatch')
    expect(await readFile(suite.calls, 'utf8')).toBe('')
    await unlink(manifest)
    expect(suite.run().status).not.toBe(0)
    expect(await readFile(suite.calls, 'utf8')).toBe('')
  }
})

it('runs a CircleCI affected file selection that exceeds the compact index parameter limit', async () => {
  const inventory = Array.from({ length: 1200 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(4, '0')}.integration.test.ts`)
  const files = inventory.filter((_file, index) => index % 2 === 0)
  const f = await fixture(Object.fromEntries(inventory.map(file => [file, ''])), { provider: 'circleci' })
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'affected', files })
  expect(reply).toMatchObject({ run: { state: 'running' } })
  const command = f.circle.triggered[0]!
  expect(parameter(command, 'partition')).toMatch(/^sha256:[a-f0-9]{64}$/)
  const checkout = await f.checkoutMirror(command[command.indexOf('--branch') + 1]!)
  const suite = await cloudSuiteRunner(checkout, command, 'circleci')
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...files]])
})

it('keeps GitHub dispatch inputs within the payload limit while preserving learned partition timings', async () => {
  const f = await fixture()
  const files = ['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const durations = Object.fromEntries(Array.from({ length: 996 }, (_, index) => [
    `apps/api/test/${String(index).padStart(4, '0')}-${'x'.repeat(18)}.integration.test.ts`, 1000,
  ]))
  Object.assign(durations, Object.fromEntries(files.map((file, index) => [file, (index + 1) * 100])))
  expect(JSON.stringify(durations).length).toBeLessThan(65_535)
  for (const file of files) await f.write(file, 'export {}\n')
  f.run('commit', '-qam', 'Change selected files')
  f.push('main')
  const partition = { index: 0, count: 2, weights: [2, 1] }
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.run('rev-parse', 'HEAD'), baseCommit: f.commit,
    suite: 'integration', partition, durations })
  const command = f.dispatched[0]!
  const inputs = Object.fromEntries(command.flatMap((value, index) => {
    if (command[index - 1] !== '-f') return []
    const separator = value.indexOf('=')
    return [[value.slice(0, separator), value.slice(separator + 1)]]
  }))
  expect(Buffer.byteLength(JSON.stringify(inputs))).toBeLessThanOrEqual(65_535)
  const checkout = await f.checkoutMirror(command[command.indexOf('--ref') + 1]!)
  expect(JSON.parse(await readFile(join(checkout, 'scripts/ci-learned-durations.json'), 'utf8')))
    .toEqual(durations)
  const suite = await cloudSuiteRunner(checkout, command, 'github')
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...integrationPartition(files, durations, partition)]])
})

it('preserves repository file indexes for oversized CircleCI rerun selections', async () => {
  const inventory = Array.from({ length: 1200 }, (_, index) => `scripts/selected-${index.toString().padStart(4, '0')}.test.mjs`)
  const files = inventory.filter((_file, index) => index % 2 === 0)
  const f = await fixture(Object.fromEntries(inventory.map(file => [file, ''])), { provider: 'circleci' })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'affected', files })
  const command = f.circle.triggered[0]!
  const checkout = await f.checkoutMirror(command[command.indexOf('--branch') + 1]!)
  const data = await readFile(join(checkout, 'ci-dispatch-inputs.json'))
  expect(parameter(command, 'partition')).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`)
  const inputs = JSON.parse(data.toString()) as { files: string }
  expect(selectByIndexes(repositoryFileList(checkout), inputs.files)).toEqual(files)
})

it('selects affected files against an explicit base from a shallow CircleCI execution checkout', async () => {
  const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(3, '0')}.integration.test.ts`)
  const f = await fixture(Object.fromEntries(files.map(file => [file, ''])), { provider: 'circleci' })
  const changed = files.slice(0, 12)
  for (const file of changed) await f.write(file, 'export {}\n')
  f.run('commit', '-qam', 'change selected tests')
  f.push('main')
  const partition = { index: 1, count: 2, tier: 'slow' as const, slowFiles: files }
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.run('rev-parse', 'HEAD'), baseCommit: f.commit,
    suite: 'integration', partition })
  const command = f.circle.triggered[0]!
  const ref = command[command.indexOf('--branch') + 1]!
  const checkout = join(f.root, 'shallow')
  const clone = spawnSync('git', ['clone', '--quiet', '--depth=1', '--branch', ref,
    pathToFileURL(join(f.root, 'mirror.git')).href, checkout], { encoding: 'utf8' })
  expect(clone.status, clone.stderr).toBe(0)
  const suite = await cloudSuiteRunner(checkout, command, 'circleci')
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...integrationPartition(changed, {}, partition)]])
})

it('rejects private fleet identifiers in dispatch metadata before publishing an execution ref', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const run = f.ports.run
  f.ports.run = async (file, args, options) => {
    if (file === 'tailscale') return { code: 0, stderr: '', stdout: JSON.stringify({
      Self: { HostName: 'fixture-private-host', TailscaleIPs: ['192.0.2.10'] }, Peer: {}, User: {},
    }) }
    return run(file, args, options)
  }
  const slowFiles = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index}.integration.test.ts`)
  slowFiles.push('apps/api/test/fixture-private-host.integration.test.ts')
  const runId = randomUUID()
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration',
    partition: { index: 0, count: 2, tier: 'slow', slowFiles } }))
    .rejects.toMatchObject({ code: 'CI_MIRROR_PRIVATE_DATA' })
  expect(f.circle.triggered).toEqual([])
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/ci/${f.commit}-${runId}`)).toBe('')
})
