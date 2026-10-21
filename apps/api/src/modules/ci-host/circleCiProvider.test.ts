import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { fixture } from './cloud.testSupport.js'
import { cloudService } from './cloudService.testSupport.js'
import { CircleCiProvider, type CloudDispatchInput } from './cloudProviders.js'
import { systemHostCiPorts } from './runner.js'
import { CloudHttp } from './cloudHttp.js'

it('keeps readiness, trigger, status, live output, final output, artifacts and cancel on one selected context', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const calls: string[][] = []
  const ports = { ...f.ports, run: async (...args: Parameters<typeof f.ports.run>) => {
    calls.push([args[0], ...args[1]])
    return f.ports.run(...args)
  } }
  const provider = new CircleCiProvider(ports, { http: new CloudHttp(ports, 'circleci', { circleToken: async () => null }) },
    { owner: 'delta', circleAccountId: 'reserve', mirrorNames: new Set(['site-ci']) })
  const run = { runId: randomUUID(), repository: 'octo/site', mirror: 'delta/site-ci', commit: f.commit,
    suite: 'lint' as const, startedAt: new Date().toISOString(), providerRunId: 'run-1', state: 'running' as const,
    finishedAt: null, exitCode: null, message: null, circleAccountId: 'reserve' }
  expect(await provider.ready()).toBe(true)
  expect(await provider.dispatch({ mirror: run.mirror, branch: 'main', runId: run.runId, suite: 'lint', slice: '' })).toBe('run-1')
  f.circle.steps = [{ num: 1, name: 'Suite', phase: 'started' }]
  f.circle.output = 'progress'
  expect(await provider.status(run)).toMatchObject({ done: false, output: { text: 'progress' } })
  expect(await provider.log(run)).toContain('progress')
  expect(await provider.artifacts(run, join(f.root, 'results'))).toMatchObject({ durations: null })
  await provider.cancel(run)
  expect(calls.some(call => call[1] === 'auth')).toBe(true)
  expect(calls.some(call => call[1] === 'run' && call[2] === 'trigger')).toBe(true)
  expect(calls.some(call => call[1] === 'job' && call[2] === 'output')).toBe(true)
  expect(calls.some(call => call[1] === 'job' && call[2] === 'artifact')).toBe(true)
  expect(f.circle.canceled).toEqual(['run-1'])
  expect(calls.flat()).not.toContain('fixture-token')
  expect(provider.circleAccountId).toBe('reserve')
})

it.each([undefined, 221366])('sends declared CircleCI pipeline parameters with compatible types: %s', async duration => {
  const config = parse(await readFile(new URL('../../../../../.circleci/config.yml', import.meta.url), 'utf8')) as {
    parameters: Record<string, { type: string; enum?: unknown[] }>
  }
  const commands: string[][] = []
  const provider = new CircleCiProvider({ ...systemHostCiPorts(), run: async (_file, args) => {
    commands.push([...args])
    return { code: 0, stdout: JSON.stringify({ id: 'pipeline' }), stderr: '' }
  } })
  const input: CloudDispatchInput = {
    mirror: 'octo/site-ci', branch: 'main', runId: 'ticket', suite: 'integration', slice: 's:1-2',
    ...(duration === undefined ? {} : { expectedDurationMs: duration }),
    scope: 'affected', files: 's:3-4', defaultBranch: 'main', baseCommit: 'a'.repeat(40),
    partition: JSON.stringify({ index: 0, count: 2 }), durations: JSON.stringify({ 'sample.test.ts': 100 }),
    gate: true,
  }
  await provider.dispatch(input)
  const parameters = Object.fromEntries(commands[0]!.flatMap((argument, index, args) => {
    if (argument !== '--parameter') return []
    const parameter = args[index + 1]!
    const separator = parameter.indexOf('=')
    const name = parameter.slice(0, separator)
    const text = parameter.slice(separator + 1)
    // The CLI converts integer arguments to JSON numbers before triggering the pipeline.
    const value = /^-?\d+$/.test(text) ? Number(text) : text
    return [[name, value]]
  }))
  expect(Object.keys(parameters).sort()).toEqual(Object.keys(config.parameters).sort())
  for (const [name, value] of Object.entries(parameters)) {
    const declaration = config.parameters[name]!
    const type = typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value
    expect(type, `CircleCI parameter ${name}`).toBe(declaration.type === 'enum' ? 'string' : declaration.type)
    if (declaration.enum) expect(declaration.enum).toContain(value)
  }
  expect(parameters.expected_duration_ms).toBe(duration ?? 0)
})

it.each([false, true])('requeues an ended CircleCI pipeline with errors once, workflow started: %s', async started => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = started ? 0 : 1
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' }
  const reply = await f.cloud.handle(start)
  if (reply.operation !== 'start') throw new Error('Expected a start reply')
  const message = 'Type error for argument expected_duration_ms: expected type: string, actual value: "221366" (type integer)'
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', errors: [{ type: 'config', message }], workflows: [] }
  f.advance(4_000)
  const main = cloudService(f.cloud, reply.run, f.commit)
  await main.service.dispatch()
  const requeued = await main.read()
  expect(requeued).toMatchObject({ run: { id: runId, state: 'queued', computer: null,
    exitCode: null, startedAt: null, finishedAt: null, message: expect.stringContaining(message),
    setupRetry: { runId: expect.any(String),
      failedComputer: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 },
      reason: expect.stringContaining(`config: ${message}`) } } })
  expect(requeued.run.setupRetry!.runId).not.toBe(runId)
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: expect.any(String), testsStarted: false },
      text: expect.stringContaining(`config: ${message}`) })
  await main.service.dispatch()
  expect(await main.read()).toMatchObject({ run: { state: 'queued', setupRetry: requeued.run.setupRetry } })
  expect(f.circle.triggered).toHaveLength(1)
})


it('leaves the podman Worker unit tests on CircleCI to the other computers', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
    suite: 'unit', part: 'unit-other' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  expect(f.circle.triggered).toEqual([])
})

it('runs the same published files on CircleCI and reads its result, log and durations back', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
    partition: { index: 1, count: 2 } })).toMatchObject({ run: { runId, state: 'running' } })
  const snapshot = f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)
  const workflowRef = `ci/${f.commit}-${runId}`
  expect(f.mirrorGit('rev-parse', `${workflowRef}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { provenance: { sourceCommit: f.commit, workflowCommit: snapshot, workflowRef } } })
  expect(f.circle.triggered).toEqual([['run', 'trigger', '--project', 'gh/octo/site-ci', '--branch', workflowRef,
    '--parameter', `run_id=${runId}`, '--parameter', 'suite=integration',
    '--parameter', 'slice=s:1,3', '--parameter', 'expected_duration_ms=0', '--parameter', 'scope=full', '--json']])
  const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
  expect(await read()).toMatchObject({ run: { state: 'running' } })
  f.circle.outcome = 'failed'; f.circle.durations = { 'apps/api/test/c.integration.test.ts': 180 }
  f.advance(4_000)
  expect(await read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: '2026-10-11T02:00:00Z' },
    text: 'Suite\nall green\n', durations: { 'apps/api/test/c.integration.test.ts': 180 } })
})

it('downloads only the durations artifacts of a finished CircleCI job', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
  const testResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [
    { file: 'apps/api/test/a.integration.test.ts', status: 'failed', durationMs: 90,
      tests: [{ name: 'a saves', status: 'failed', durationMs: 20, message: 'expected 1 to be 2' }] }] }
  Object.assign(f.circle, { outcome: 'failed', durations: { 'apps/api/test/a.integration.test.ts': 90 }, testResults })
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true, testResults: true }))
    .toMatchObject({ run: { state: 'failed' }, durations: { 'apps/api/test/a.integration.test.ts': 90 }, testResults })
  expect(f.circle.downloaded).toEqual(['https://artifacts.example/durations/durations.json',
    'https://artifacts.example/durations/test-results.json'])
})

it('answers a read while another read is still collecting the finished run', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
  let release!: () => void
  f.circle.downloadGate = new Promise(resolve => { release = resolve })
  Object.assign(f.circle, { outcome: 'failed', durations: { 'apps/api/test/a.integration.test.ts': 90 } })
  const collecting = f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
  await expect.poll(() => f.circle.downloaded.length).toBe(1)
  // The artifacts come first and the log follows them, so the log is not kept yet; the read still answers at once.
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'failed', collection: 'pending' } })
  release()
  expect(await collecting).toMatchObject({ run: { state: 'failed' }, text: 'Suite\nall green\n',
    durations: { 'apps/api/test/a.integration.test.ts': 90 } })
})


it('streams the running CircleCI step output into the log as it grows', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
  f.circle.steps = [{ num: 101, name: 'Checkout code', phase: 'ended', outcome: 'succeeded' },
    { num: 108, name: 'Suite', phase: 'started' }]
  f.circle.output = 'a.test passed\n'
  const read = (afterOffset = 0) => f.cloud.handle({ operation: 'read', runId, afterOffset, maxBytes: 65_536 })
  const first = await read()
  expect(first).toMatchObject({ run: { state: 'running', step: 'Suite' }, text: '==> Checkout code\n==> Suite\na.test passed\n' })
  f.circle.output += 'b.test passed\n'
  f.advance(60_000)
  expect(await read(first.operation === 'read' ? first.nextOffset : 0)).toMatchObject({ text: 'b.test passed\n' })
})


it('archives CircleCI Suite stdout and stderr while preserving the failing exit code', async () => {
  const config = parse(await readFile(new URL('../../../../../.circleci/config.yml', import.meta.url), 'utf8')) as {
    jobs: { ci: { steps: { run?: { name?: string; command?: string } }[] } }
  }
  const suite = config.jobs.ci.steps.find(step => step.run?.name === 'Suite')?.run?.command
  if (!suite) throw new Error('Expected a Suite command')
  const f = await fixture({ 'scripts/ci-suite.sh': '#!/bin/bash\necho "test progress"\n'
    + 'echo "[integration] FAIL apps/api/test/a.integration.test.ts (slot 1, exit 7)" >&2\nexit 7\n' })
  const work = join(f.root, 'work')
  await chmod(join(work, 'scripts/ci-suite.sh'), 0o700)
  await expect(promisify(execFile)('bash', ['-c', suite], { cwd: work }))
    .rejects.toMatchObject({ code: 7 })
  expect(await readFile(join(work, '.logs/ci-durations/suite.log'), 'utf8'))
    .toBe('test progress\n[integration] FAIL apps/api/test/a.integration.test.ts (slot 1, exit 7)\n')
})

