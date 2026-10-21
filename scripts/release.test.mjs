import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { releaseRoundProblems } from './verify-release-round.mjs'

const releaseScript = new URL('./release.mjs', import.meta.url).pathname
const verifyScript = new URL('./verify-release-round.mjs', import.meta.url).pathname
const workspaceId = 'workspace-release-test'

/** A Main whose CI finishes every run at once; `outcome(run)` picks each run's final state. */
async function fakeMain(t, outcome = () => 'passed', beforeWait = () => {}) {
  const runs = new Map(), groups = new Map(), calls = [], commands = new Map()
  const tools = {
    ci_run: input => {
      // Like Main, a repeated commandId returns the original tickets instead of starting new ones.
      if (input.commandId && commands.has(input.commandId)) return commands.get(input.commandId)
      const { suite, commit, scope, partitions, gate } = input
      const groupId = randomUUID()
      // A gate is one group with typecheck, lint, unit and integration parts.
      const suites = gate ? ['typecheck', 'typecheck', 'lint', 'lint', 'unit', 'unit', 'unit', 'integration', 'integration', 'integration']
        : Array.from({ length: partitions ?? (suite === 'unit' ? 2 : 1) }, () => suite)
      const count = suites.length
      const group = suites.map((value, index) => ({ id: randomUUID(), workspaceId, suite: value, commit,
        scope: scope ?? 'affected', groupId, part: null, partition: count > 1 ? { index, count } : null, computer: null,
        message: null, ...(gate ? { gate: true } : {}) }))
      for (const run of group) runs.set(run.id, { ...run, state: outcome(run) })
      groups.set(groupId, group.map(run => run.id))
      const reply = count > 1 ? { ticketId: group[0].id, partitions: group.map(run => ({ ticketId: run.id })) } : { ticketId: group[0].id }
      if (input.commandId) commands.set(input.commandId, reply)
      return reply
    },
    ci_get: ({ ticketId, testStatus, waitUntil }) => {
      const run = runs.get(ticketId)
      if (!run) throw new Error('Unknown ticket.')
      if (waitUntil) beforeWait(run, runs, groups)
      const group = groups.get(run.groupId).map(id => runs.get(id))
      return { run, logTail: '', partitions: group.length > 1 ? group : undefined,
        ...(waitUntil ? { wait: { status: 'settled' } } : {}),
        ...(testStatus ? { tests: run.state === 'failed'
          ? { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [{ file: 'apps/api/src/broken.test.ts',
            status: 'failed', durationMs: 1, tests: [{ name: 'breaks on purpose', status: 'failed', durationMs: 1 }] }] }
          : null } : {}) }
    },
    ci_logs_read: () => ({ text: 'FAIL apps/api/src/broken.test.ts\n', nextOffset: 0 }),
  }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const { id, method, params } = JSON.parse(body)
    const reply = result => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id, result })) }
    if (request.headers.authorization !== 'Bearer release-test-token') { response.statusCode = 401; return reply(undefined) }
    if (method === 'initialize') return reply({ protocolVersion: '2025-11-25' })
    calls.push({ name: params.name, arguments: params.arguments })
    try { reply({ content: [{ type: 'text', text: JSON.stringify(tools[params.name](params.arguments)) }] }) }
    catch (error) { reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ message: error.message }) }] }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, runs, calls, groups }
}

function repository(t) {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const root = mkdtempSync(join(temporaryRoot, 'release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com' }
  const work = join(root, 'work'), origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim()
  writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "version": "1.0.0"\n}\n')
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n')
  git('add', '.'); git('commit', '-qm', 'first'); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main')
  return { work, git, env }
}

function run(script, args, cwd, main, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...env, FOREMAN_CODE_MAIN_URL: main.url,
      FOREMAN_CODE_OPERATOR_TOKEN: 'release-test-token', FOREMAN_CODE_WORKSPACE_ID: workspaceId, FOREMAN_CODE_CI_PARTITIONS: '3' } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('exit', status => resolve({ status, output }))
  })
}

test('a clean gate releases HEAD with every gate ticket recorded and pushes it', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 0, result.output)
  const started = main.calls.filter(call => call.name === 'ci_run').map(call => call.arguments)
  assert.deepEqual(started.map(value => [value.suite, value.scope, value.commit, value.gate, value.priority, value.commandId]),
    [['integration', 'full', tested, true, 'high', `gate-${tested}`]])
  assert.equal(git('log', '-1', '--format=%s'), 'Release v1.1.0')
  assert.equal(git('rev-parse', 'HEAD^'), tested)
  assert.equal(git('rev-parse', 'origin/main'), git('rev-parse', 'HEAD'))
  const trailers = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly,separator=%x0a)').split('\n')
  assert.equal(trailers.length, 1)
  const [label, ids] = trailers[0].split('=')
  assert.equal(label, 'gate')
  assert.deepEqual(new Set(ids.split(',').map(id => main.runs.get(id).suite)), new Set(['typecheck', 'lint', 'unit', 'integration']))
  assert.equal(ids.split(',').length, 10)
  assert.equal(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version, '1.1.0')
  assert.match(readFileSync(join(work, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n\n- A fix\.\n\n## \[1\.0\.0\]/)

  const verified = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(verified.status, 0, verified.output)
})

for (const state of ['passed', 'failed']) {
  test(`a fallback sibling that ${state} during the wait is included before creating a release`, async t => {
    let added
    const main = await fakeMain(t, () => 'passed', (run, runs, groups) => {
      if (added) return
      const original = groups.get(run.groupId).map(id => runs.get(id)).find(part => part.suite === 'integration')
      added = { ...original, id: randomUUID(), partition: null, state }
      runs.set(added.id, added)
      groups.get(run.groupId).push(added.id)
    })
    const { work, git, env } = repository(t)
    const tested = git('rev-parse', 'HEAD')
    const result = await run(releaseScript, ['1.1.0'], work, main, env)
    assert.ok(added)
    if (state === 'failed') {
      assert.equal(result.status, 1, result.output)
      assert.equal(git('rev-parse', 'HEAD'), tested)
      assert.equal(git('status', '--porcelain'), '')
      assert.equal(git('rev-parse', 'origin/main'), tested)
      return
    }
    assert.equal(result.status, 0, result.output)
    const ids = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly)').split('=')[1].split(',')
    assert.deepEqual(ids.sort(), [...main.runs.keys()].sort())
    assert.equal(git('rev-parse', 'origin/main'), git('rev-parse', 'HEAD'))
  })
}

test('a release reuses the gate that already passed on HEAD instead of running another round', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  // The gate line already gated this commit with the canonical commandId.
  const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
      workspaceId, commit: tested, suite: 'integration', scope: 'full', gate: true, priority: 'high', commandId: `gate-${tested}` } } }) })
  const earlier = JSON.parse((await response.json()).result.content[0].text)
  const groupsBefore = main.groups.size
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 0, result.output)
  assert.equal(main.groups.size, groupsBefore)
  const trailer = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly)')
  assert.deepEqual(trailer.split('=')[1].split(',').sort(), earlier.partitions.map(value => value.ticketId).sort())
  const verified = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(verified.status, 0, verified.output)
})

test('a release named with --gate-ticket reuses that clean gate even when it was started under another commandId', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  // Another credential's gate on this commit: its commandId receipt is not the release's.
  const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
      workspaceId, commit: tested, suite: 'integration', scope: 'full', gate: true, priority: 'high', commandId: 'other-gate' } } }) })
  const earlier = JSON.parse((await response.json()).result.content[0].text)
  const groupsBefore = main.groups.size
  const result = await run(releaseScript, ['1.1.0', '--gate-ticket', earlier.partitions[3].ticketId], work, main, env)
  assert.equal(result.status, 0, result.output)
  assert.equal(main.groups.size, groupsBefore)
  const trailer = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly)')
  assert.deepEqual(trailer.split('=')[1].split(',').sort(), earlier.partitions.map(value => value.ticketId).sort())
  const verified = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(verified.status, 0, verified.output)
})

test('a --gate-ticket from another commit creates no release', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
      workspaceId, commit: 'a'.repeat(40), suite: 'integration', scope: 'full', gate: true, priority: 'high' } } }) })
  const other = JSON.parse((await response.json()).result.content[0].text)
  const before = git('rev-parse', 'HEAD')
  const result = await run(releaseScript, ['1.1.0', '--gate-ticket', other.ticketId], work, main, env)
  assert.notEqual(result.status, 0, result.output)
  assert.equal(git('rev-parse', 'HEAD'), before)
  assert.equal(git('rev-parse', 'origin/main'), before)
})

test('the verifier rejects a gate round with a missing ticket, a missing suite or a non-gate part', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const start = async input => {
    const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
        workspaceId, commit: tested, scope: 'full', ...input } } }) })
    const started = JSON.parse((await response.json()).result.content[0].text)
    return (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)
  }
  const gate = await start({ suite: 'integration', gate: true, commandId: `gate-${tested}` })
  releaseCommit(git, work, [['gate', gate.slice(1)]])
  let result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /gate: the recorded tickets are not the whole CI group/)

  git('reset', '-q', '--hard', tested)
  const integration = await start({ suite: 'integration', partitions: 2 })
  releaseCommit(git, work, [['gate', integration]])
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /is not a gate run/)
  assert.match(result.output, /gate round has no typecheck part/)
})

test('one failed partition prints its ticket and test and creates no release', async t => {
  let integrationParts = 0
  const main = await fakeMain(t, run => run.suite === 'integration' && ++integrationParts === 2 ? 'failed' : 'passed')
  const { work, git, env } = repository(t)
  const head = git('rev-parse', 'HEAD')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 1)
  const failed = [...main.runs.values()].find(value => value.state === 'failed')
  assert.match(result.output, new RegExp(`integration ticket ${failed.id} failed`))
  assert.match(result.output, /failed test apps\/api\/src\/broken\.test\.ts > breaks on purpose/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('ls-remote', 'origin', 'main').split(/\s/)[0], head)
  assert.equal(git('status', '--porcelain'), '')
})

test('refuses to release from a dirty worktree without starting CI', async t => {
  const main = await fakeMain(t)
  const { work, env } = repository(t)
  writeFileSync(join(work, 'package.json'), '{}\n')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /uncommitted changes/)
  assert.equal(main.calls.length, 0)
})

/** A release commit on top of the tested code whose trailers list the given groups. */
function releaseCommit(git, work, groups, reruns = []) {
  writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "version": "1.1.0"\n}\n')
  const trailers = groups.map(([suite, ids]) => `Clean-Round: ${suite}=${ids.join(',')}`)
  trailers.push(...reruns.map(value => `Clean-Round-Rerun: ${value}`))
  git('commit', '-qam', 'Release v1.1.0', '-m', trailers.join('\n'))
}

test('the verifier rejects a release with no recorded round, a failed part or affected scope', async t => {
  const outcomes = new Map()
  const main = await fakeMain(t, run => outcomes.get(run.suite) ?? 'passed')
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const round = async (scope) => {
    const groups = []
    for (const suite of ['typecheck', 'lint', 'unit', 'integration']) {
      const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
          workspaceId, suite, commit: tested, scope, ...(suite === 'integration' ? { partitions: 2 } : {}) } } }) })
      const started = JSON.parse((await response.json()).result.content[0].text)
      groups.push([suite, (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)])
    }
    return groups
  }

  releaseCommit(git, work, [])
  let result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /No clean typecheck round is recorded/)

  git('reset', '-q', '--hard', tested)
  releaseCommit(git, work, await round('affected'))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /affected scope, not full/)

  git('reset', '-q', '--hard', tested)
  outcomes.set('lint', 'failed')
  releaseCommit(git, work, await round('full'))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /lint ticket \S+ failed/)

  git('reset', '-q', '--hard', tested)
  outcomes.clear()
  const groups = await round('full')
  releaseCommit(git, work, groups.map(([suite, ids]) => [suite, suite === 'integration' ? ids.slice(1) : ids]))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /integration: the recorded tickets are not the whole CI group/)

  git('reset', '-q', '--hard', tested)
  writeFileSync(join(work, 'code.js'), 'untested\n'); git('add', 'code.js')
  releaseCommit(git, work, groups)
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /changes code beyond the version and changelog: code\.js/)
})


async function rerunFixture(t) {
  const main = await fakeMain(t)
  const repo = repository(t)
  const tested = repo.git('rev-parse', 'HEAD')
  const groupId = randomUUID()
  const group = ['typecheck', 'lint', 'unit', 'integration', 'integration'].map((suite, index) => ({
    id: randomUUID(), workspaceId, groupId, suite, commit: tested, scope: 'full', gate: true,
    state: index === 3 ? 'failed' : 'passed', part: null, partition: null, computer: null,
    files: [`apps/api/test/feature${index}.integration.test.ts`, `apps/api/test/other${index}.integration.test.ts`],
    message: index === 3 ? 'Build computer setup failed.' : null,
  }))
  for (const value of group) main.runs.set(value.id, value)
  main.groups.set(groupId, group.map(value => value.id))
  const failed = group[3]
  const replacement = { ...failed, id: randomUUID(), groupId: randomUUID(), state: 'passed',
    scope: 'affected', gate: undefined, files: [...failed.files].reverse(), message: null }
  main.runs.set(replacement.id, replacement)
  main.groups.set(replacement.groupId, [replacement.id])
  const read = async (name, input) => {
    assert.equal(name, 'ci_get')
    assert.equal(input.workspaceId, workspaceId)
    main.calls.push({ name, arguments: input })
    const value = main.runs.get(input.ticketId)
    if (!value) throw new Error('Unknown ticket.')
    return { run: value, partitions: main.groups.get(value.groupId).map(id => main.runs.get(id)) }
  }
  return { ...repo, main, tested, group, failed, replacement, read }
}

test('a named gate releases with a passed rerun of the failed files and records both tickets', async t => {
  const f = await rerunFixture(t)
  const substitution = `${f.failed.id}=${f.replacement.id}`
  const result = await run(releaseScript, ['1.1.0', '--gate-ticket', f.group[0].id,
    '--rerun', substitution], f.work, f.main, f.env)
  assert.equal(result.status, 0, result.output)
  assert.equal(f.main.calls.some(call => call.name === 'ci_run'), false)
  assert.equal(f.git('log', '-1', '--format=%(trailers:key=Clean-Round-Rerun,valueonly)'), substitution)
  const ids = f.git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly)').split('=')[1].split(',')
  assert.deepEqual(ids.sort(), f.group.map(value => value.id).sort())
  assert.equal(f.git('rev-parse', 'origin/main'), f.git('rev-parse', 'HEAD'))
  assert.deepEqual(await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work), [])
  assert.ok(f.main.calls.some(call => call.arguments.ticketId === f.replacement.id))
})

test('repeatable --rerun replaces each failed gate part independently', async t => {
  const f = await rerunFixture(t)
  const second = f.group[4]
  second.state = 'failed'
  const replacement = { ...second, id: randomUUID(), groupId: randomUUID(), state: 'passed', scope: 'affected' }
  f.main.runs.set(replacement.id, replacement)
  f.main.groups.set(replacement.groupId, [replacement.id])
  const reruns = [`${f.failed.id}=${f.replacement.id}`, `${second.id}=${replacement.id}`]
  const result = await run(releaseScript, ['1.1.0', '--rerun', reruns[0], '--gate-ticket', f.group[0].id,
    '--rerun', reruns[1]], f.work, f.main, f.env)
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(f.git('log', '-1', '--format=%(trailers:key=Clean-Round-Rerun,valueonly,separator=%x0a)')
    .split('\n').sort(), reruns.sort())
  assert.deepEqual(await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work), [])
})

function splitReplacement(f) {
  const [first, second] = f.failed.files
  f.replacement.files = [first]
  const sibling = { ...f.replacement, id: randomUUID(), files: [second] }
  f.main.runs.set(sibling.id, sibling)
  f.main.groups.set(f.replacement.groupId, [f.replacement.id, sibling.id])
  return sibling
}

test('a rerun split across partitions replaces the failed part when together they ran its files', async t => {
  const f = await rerunFixture(t)
  splitReplacement(f)
  const substitution = `${f.failed.id}=${f.replacement.id}`
  const result = await run(releaseScript, ['1.1.0', '--gate-ticket', f.group[0].id,
    '--rerun', substitution], f.work, f.main, f.env)
  assert.equal(result.status, 0, result.output)
  assert.equal(f.git('log', '-1', '--format=%(trailers:key=Clean-Round-Rerun,valueonly)'), substitution)
  assert.deepEqual(await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work), [])
})

const invalidReruns = [
  ['missing rerun', f => []],
  ['failed replacement', f => { f.replacement.state = 'failed' }],
  ['running replacement', f => { f.replacement.state = 'running' }],
  ['different files', f => { f.replacement.files = [f.failed.files[0]] }],
  ['extra files', f => { f.replacement.files.push('apps/api/test/extra.integration.test.ts') }],
  ['duplicate files', f => { f.replacement.files = [f.failed.files[0], f.failed.files[0]] }],
  ['missing file selection', f => { delete f.replacement.files }],
  ['missing original file selection', f => { delete f.failed.files }],
  ['unresolved replacement selection', f => { f.replacement.deriveFiles = true }],
  ['different suite', f => { f.replacement.suite = 'unit' }],
  ['failed rerun partition', f => { splitReplacement(f).state = 'failed' }],
  ['rerun partitions missing a file', f => { splitReplacement(f).files = [f.failed.files[0]] }],
  ['rerun partition on an unrelated commit', f => {
    splitReplacement(f).commit = f.git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated')
  }],
  ['unrelated commit', f => { f.replacement.commit = f.git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated') }],
  ['unknown commit', f => { f.replacement.commit = 'a'.repeat(40) }],
  ['another failed gate part', f => { f.group[4].state = 'failed' }],
  ['replaced ticket outside the gate', f => {
    f.failed.state = 'passed'
    return [`${randomUUID()}=${f.replacement.id}`]
  }],
  ['replacement is unreadable', f => [`${f.failed.id}=${randomUUID()}`]],
  ['replaced ticket passed', f => { f.failed.state = 'passed' }],
  ['replaced ticket canceled', f => { f.failed.state = 'canceled' }],
  ['non-gate original part', f => { f.failed.gate = false }],
  ['affected original scope', f => { f.failed.scope = 'affected' }],
  ['original commit mismatch', f => { f.failed.commit = 'a'.repeat(40) }],
  ['missing gate suite', f => { f.group[0].suite = 'lint' }],
  ['duplicate substitution', f => Array(2).fill(`${f.failed.id}=${f.replacement.id}`)],
  ['malformed substitution', () => ['not-a-pair']],
  ['extra equals sign', f => [`${f.failed.id}=${f.replacement.id}=extra`]],
  ['empty substitution on a passed gate', f => {
    f.failed.state = 'passed'
    return ['']
  }],
]

for (const [label, configure] of invalidReruns) {
  test(`release and verifier reject ${label}`, async t => {
    const f = await rerunFixture(t)
    const reruns = configure(f) ?? [`${f.failed.id}=${f.replacement.id}`]
    const args = ['1.1.0', '--gate-ticket', f.group[0].id, ...reruns.flatMap(value => ['--rerun', value])]
    const result = await run(releaseScript, args, f.work, f.main, f.env)
    assert.equal(result.status, 1, result.output)
    assert.equal(f.git('rev-parse', 'HEAD'), f.tested)
    assert.equal(f.git('rev-parse', 'origin/main'), f.tested)
    assert.equal(f.git('status', '--porcelain'), '')
    assert.equal(f.main.calls.some(call => call.name === 'ci_run'), false)
    releaseCommit(f.git, f.work, [['gate', f.group.map(value => value.id)]], reruns)
    const problems = await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work)
    assert.ok(problems.length > 0, `Verifier accepted ${label}`)
  })
}

test('--rerun requires --gate-ticket and creates no CI request', async t => {
  const f = await rerunFixture(t)
  const result = await run(releaseScript, ['1.1.0', '--rerun', `${f.failed.id}=${f.replacement.id}`],
    f.work, f.main, f.env)
  assert.equal(result.status, 1, result.output)
  assert.equal(f.git('rev-parse', 'HEAD'), f.tested)
  assert.equal(f.main.calls.length, 0)
})

for (const target of ['tested code', 'release commit', 'descendant']) {
  test(`the verifier accepts matching rerun files on the ${target}`, async t => {
    const f = await rerunFixture(t)
    releaseCommit(f.git, f.work, [['gate', f.group.map(value => value.id)]], [`${f.failed.id}=${f.replacement.id}`])
    const release = f.git('rev-parse', 'HEAD')
    if (target === 'release commit') f.replacement.commit = release
    if (target === 'descendant') {
      f.git('commit', '--allow-empty', '-qm', 'later CI fix')
      f.replacement.commit = f.git('rev-parse', 'HEAD')
    }
    assert.deepEqual(await releaseRoundProblems(f.read, workspaceId, release, f.work), [])
  })
}

test('a named gate accepts a matching rerun on a descendant of its code commit', async t => {
  const f = await rerunFixture(t)
  f.git('commit', '--allow-empty', '-qm', 'later CI fix')
  f.replacement.commit = f.git('rev-parse', 'HEAD')
  f.git('reset', '-q', '--hard', f.tested)
  const result = await run(releaseScript, ['1.1.0', '--gate-ticket', f.group[0].id,
    '--rerun', `${f.failed.id}=${f.replacement.id}`], f.work, f.main, f.env)
  assert.equal(result.status, 0, result.output)
})

test('the verifier reads the named replacement rather than another ticket in its group', async t => {
  const f = await rerunFixture(t)
  const sibling = { ...f.replacement, id: randomUUID(), files: ['apps/api/test/extra.integration.test.ts'], state: 'failed' }
  f.main.runs.set(sibling.id, sibling)
  f.main.groups.set(f.replacement.groupId, [sibling.id, f.replacement.id])
  releaseCommit(f.git, f.work, [['gate', f.group.map(value => value.id)]], [`${f.failed.id}=${f.replacement.id}`])
  assert.deepEqual(await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work), [])
})

test('the verifier rejects a rerun trailer without a gate round', async t => {
  const f = await rerunFixture(t)
  const groups = ['typecheck', 'lint', 'unit', 'integration'].map(suite => {
    const value = { ...f.replacement, id: randomUUID(), groupId: randomUUID(), suite, scope: 'full' }
    f.main.runs.set(value.id, value)
    f.main.groups.set(value.groupId, [value.id])
    return [suite, [value.id]]
  })
  releaseCommit(f.git, f.work, groups, [`${f.failed.id}=${f.replacement.id}`])
  assert.ok((await releaseRoundProblems(f.read, workspaceId, 'HEAD', f.work)).length > 0)
})
