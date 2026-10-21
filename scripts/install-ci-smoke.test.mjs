import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function fixture(t, failure, token, { firstAdmissionDelayMs = 0, firstAdmissionProbes = 0, slowTicketPolls = 0, slowDiscoveries = 0, unreachableSmokes = 0, updatingDiscoveries = 0, answeredDiscoveries = Infinity, pendingReportPolls = 0 } = {}) {
  const computers = [
    { hostRef: { kind: 'device', mainId: 'main', deviceId: 'first' }, ready: true },
    { hostRef: { kind: 'device', mainId: 'main', deviceId: 'second' }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 1 }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 }, ready: true },
  ]
  if (failure === 'unready') {
    computers[1].ready = false
    computers[1].reasons = ['CI setup: git unavailable']
  }
  const admissions = []
  const canceled = []
  let probes = 0
  let firstAdmissionProbeCount = 0
  let firstAdmissionComplete = false
  const admissionProbed = Promise.withResolvers()
  const authenticated = []
  const reportPolls = new Map()
  const reportReads = []
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url.startsWith('/api/')) {
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 403
        response.end(JSON.stringify({ code: 'LOCAL_HUMAN_REQUIRED',
          message: 'Agent processes require an application credential.' }))
        return
      }
      authenticated.push({ method: request.method, url: request.url })
    }
    if (request.url.startsWith('/api/management/workspaces?')) {
      const nextPage = request.url.includes('cursor=next')
      response.end(JSON.stringify({ items: nextPage ? [{ workspace: { id: 'workspace',
        repository: { owner: 'example', name: 'project' } } }] : [],
        pageInfo: { nextCursor: nextPage ? null : 'next' } }))
    } else if (request.url === '/health/live') {
      probes++
      if (failure === 'stall' && admissions.length) return
      if (admissions.length === 1 && !firstAdmissionComplete) {
        firstAdmissionProbeCount++
        if (firstAdmissionProbeCount >= firstAdmissionProbes) admissionProbed.resolve()
      }
      response.end('{}')
    } else if (request.url.endsWith('/tests')) {
      const ticketId = request.url.split('/').at(-2)
      const pending = (reportPolls.get(ticketId) ?? 0) <= pendingReportPolls
      reportReads.push({ ticketId, pending })
      if (pending) {
        response.end(JSON.stringify({ tests: null }))
        return
      }
      response.end(JSON.stringify({ tests: { summary: { passed: 1, failed: 0, skipped: 0 },
        files: failure === 'missing-report-file' ? []
          : [{ file: 'apps/api/test/ci-smoke.integration.test.ts', tests: [{ status: 'passed' }] }] } }))
    } else if (request.url.endsWith('/computers')) {
      // Later discoveries never answer, so the smoke deadline lands while one is in flight.
      if (answeredDiscoveries-- <= 0) return
      if (slowDiscoveries > 0) {
        slowDiscoveries--
        await delay(200)
      }
      const observed = computers.map(computer => ({ ...computer }))
      if (updatingDiscoveries > 0) {
        updatingDiscoveries--
        observed[1] = { ...observed[1], ready: false, reasons: ['Worker bundle update is in progress'] }
      }
      response.end(JSON.stringify({ computers: observed }))
    }
    else if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      if (input.smokeComputer && unreachableSmokes > 0) {
        unreachableSmokes--
        response.statusCode = 503
        response.end(JSON.stringify({ error: { code: 'CI_SMOKE_COMPUTER_UNAVAILABLE',
          message: 'The smoke computer is not reachable yet. Retry shortly.', details: { retryable: true } } }))
        return
      }
      admissions.push(input)
      if (failure === 'lock' && admissions.length === 2) return
      if (admissions.length === 1) {
        if (firstAdmissionProbes > 0) await admissionProbed.promise
        await delay(firstAdmissionDelayMs)
        firstAdmissionComplete = true
      }
      response.end(JSON.stringify({ ticketId: `ticket-${admissions.length}` }))
    } else if (request.method === 'DELETE') {
      let body = ''
      for await (const chunk of request) body += chunk
      // Like the API, a JSON content type needs a JSON body.
      if (request.headers['content-type']?.includes('application/json') && !body) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'The request body must contain valid JSON.' } }))
        return
      }
      canceled.push(request.url)
      response.end('{}')
    } else {
      if (slowTicketPolls > 0) {
        slowTicketPolls--
        await delay(200)
      }
      const input = admissions[Number(request.url.split('-').at(-1)) - 1]
      const ticketId = request.url.split('/').at(-1)
      const polls = (reportPolls.get(ticketId) ?? 0) + 1
      reportPolls.set(ticketId, polls)
      const failed = ['setup', 'credential-echo'].includes(failure) && input?.smokeComputer?.deviceId === 'second'
      let state = failed ? 'failed' : 'passed'
      if (failure === 'stall' && input?.smokeComputer) state = 'running'
      let message = failed ? 'ERR_PNPM_NO_OFFLINE_META: package metadata missing' : null
      if (failure === 'credential-echo' && failed) message = `Executor echoed ${token}`
      response.end(JSON.stringify({ run: { state, exitCode: failed ? 1 : 0, message,
        ...(input?.smokeComputer ? { collection: polls <= pendingReportPolls ? 'pending' : 'complete' } : {}),
        computer: { hostRef: input?.smokeComputer }, files: input?.files },
        logTail: failed ? 'setup failed: ERR_PNPM_NO_OFFLINE_META' : 'one test passed' }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://127.0.0.1:${server.address().port}`, admissions, canceled, computers, authenticated,
    probes: () => probes, firstAdmissionProbes: () => firstAdmissionProbeCount, reportReads }
}

const options = { workspaceId: 'workspace', commit: 'a'.repeat(40),
  timeoutMs: 1000, requestTimeoutMs: 60, admissionTimeoutMs: 60, pollMs: 10 }

test('passed smoke tickets wait for report collection before verifying the executed file', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { pendingReportPolls: 3 })
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.equal(f.reportReads.length, 4)
  assert.ok(f.reportReads.every(read => !read.pending))
  assert.equal(f.canceled.length, 0)
})

test('completed reports missing the smoke file still fail loudly', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, 'missing-report-file')
  await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin }),
    /passed without running apps\/api\/test\/ci-smoke.integration.test.ts/)
  assert.ok(f.canceled.length > 0)
})

test('passed tickets whose reports stay pending fail at the existing smoke deadline', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { pendingReportPolls: Infinity })
  await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin, timeoutMs: 300 }),
    /CI smoke timed out after 300 ms/)
  assert.equal(f.reportReads.length, 0)
  assert.ok(f.canceled.length > 0)
})

test('production smoke allows the first commit admission to take longer than five seconds', async t => {
  const { runProductionCiSmoke } = await import('./install-ci-smoke.mjs')
  const token = 'smoke-test-credential'
  const f = await fixture(t, undefined, token, { firstAdmissionDelayMs: 5200 })
  const messages = []
  await runProductionCiSmoke({ origin: f.origin, release: await releaseFixture(t), token,
    timeoutMs: 15_000, pollMs: 25, log: message => messages.push(message) })
  assert.equal(f.admissions.length, 6)
  assert.ok(f.probes() > 3, 'Health probes continue while commit resolution is in progress')
  assert.ok(messages.some(message => /admission 1.*POST.*\/ci.*\d+ ms/.test(message)))
})

test('a stalled health probe fails quickly while a slow admission is still in progress', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, 'stall', undefined, { firstAdmissionDelayMs: 200 })
  const started = Date.now()
  await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin, admissionTimeoutMs: 800 }),
    /health probe.*GET \/health\/live.*timed out.*60 ms/)
  assert.ok(Date.now() - started < 700)
})

test('a stuck admission has its own bounded timeout and identifies the slow step', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, 'lock')
  await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin, admissionTimeoutMs: 100 }),
    /admission 2.*POST.*\/ci.*timed out.*100 ms/)
  assert.ok(f.canceled.length > 0)
})

test('CI smoke probes repeatedly, makes consecutive admissions and tests each ready executor', { timeout: 30_000 }, async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { firstAdmissionProbes: 3 })
  // Tiny request budgets belong to the timeout cases; this case observes successful HTTP work.
  await runInstallCiSmoke({ origin: f.origin, workspaceId: options.workspaceId, commit: options.commit,
    pollMs: options.pollMs })
  assert.deepEqual(f.admissions.slice(0, 2).map(input => input.files), [[], []])
  assert.notEqual(f.admissions[0].commandId, f.admissions[1].commandId)
  const targets = f.admissions.filter(input => input.smokeComputer)
  assert.deepEqual(targets.map(input => input.smokeComputer),
    [f.computers[0], f.computers[1], f.computers[2], f.computers[4]].map(computer => computer.hostRef))
  assert.ok(targets.every(input => input.files.length === 1 && input.scope === 'affected'))
  assert.ok(f.probes() >= 3)
  assert.equal(f.firstAdmissionProbes(), 3)
})

for (const failure of ['setup', 'lock', 'stall']) {
  test(`CI smoke fails closed and cancels its admitted jobs on ${failure}`, async t => {
    const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
    const f = await fixture(t, failure)
    const started = Date.now()
    await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin }),
      failure === 'setup' ? /ERR_PNPM_NO_OFFLINE_META/ : /timed out/)
    assert.ok(Date.now() - started < 1500)
    assert.ok(f.canceled.length > 0)
  })
}

test('a slow ticket poll is retried until the smoke deadline instead of failing the smoke', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { slowTicketPolls: 1 })
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.equal(f.admissions.filter(input => input.smokeComputer).length, 4)
})

test('a slow computer discovery is retried until the smoke deadline instead of failing the smoke', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { slowDiscoveries: 1 })
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.equal(f.admissions.filter(input => input.smokeComputer).length, 4)
})

test('a smoke computer that is still reconnecting is admitted again within the smoke deadline', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { unreachableSmokes: 1 })
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.equal(f.admissions.filter(input => input.smokeComputer).length, 4)
})

test('CI smoke fails for an enabled build computer that became unready', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, 'unready')
  await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin }), /CI setup: git unavailable/)
  assert.equal(f.admissions.filter(input => input.smokeComputer).length, 0)
})

test('CI smoke names the unready build computer when the deadline lands during a later discovery', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, 'unready', undefined, { answeredDiscoveries: 1 })
  await assert.rejects(runInstallCiSmoke({ ...options, timeoutMs: 300, origin: f.origin }), /CI setup: git unavailable/)
  assert.equal(f.admissions.filter(input => input.smokeComputer).length, 0)
})

test('only the explicit install opt-out bypasses CI smoke', async t => {
  const { runProductionCiSmoke } = await import('./install-ci-smoke.mjs')
  const previous = process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE
  t.after(() => {
    if (previous === undefined) delete process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE
    else process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE = previous
  })
  const input = { origin: 'http://127.0.0.1:9', release: '/missing-release' }
  process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE = '1'
  await runProductionCiSmoke(input)
  for (const value of ['0', 'true', '']) {
    process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE = value
    await assert.rejects(runProductionCiSmoke(input), { code: 'ENOENT' })
  }
})

async function releaseFixture(t) {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  const release = await mkdtemp(join(root, 'install-smoke-'))
  t.after(() => rm(release, { recursive: true, force: true }))
  await writeFile(join(release, 'ci-smoke.json'), JSON.stringify({
    repository: 'example/project', commit: options.commit,
  }))
  return release
}

test('production smoke authenticates workspace pagination and every CI request from an agent', async t => {
  const { runProductionCiSmoke } = await import('./install-ci-smoke.mjs')
  const token = 'smoke-test-credential'
  const f = await fixture(t, undefined, token)
  const denied = await fetch(`${f.origin}/api/management/workspaces?limit=100`)
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'LOCAL_HUMAN_REQUIRED')
  await runProductionCiSmoke({ ...options, origin: f.origin, release: await releaseFixture(t), token })
  assert.equal(f.authenticated.filter(request => request.url.includes('workspaces?')).length, 2)
  assert.equal(f.admissions.length, 6)
  assert.ok(f.authenticated.some(request => request.url.endsWith('/computers')))
  assert.ok(f.authenticated.some(request => request.url.endsWith('/tests')))
})

test('authenticated smoke cancels admitted tickets after an executor failure', async t => {
  const { runProductionCiSmoke } = await import('./install-ci-smoke.mjs')
  const token = 'smoke-test-credential'
  const f = await fixture(t, 'setup', token)
  await assert.rejects(runProductionCiSmoke({ ...options, origin: f.origin,
    release: await releaseFixture(t), token }), /ERR_PNPM_NO_OFFLINE_META/)
  assert.ok(f.canceled.length > 0)
  assert.equal(f.authenticated.filter(request => request.method === 'DELETE').length, f.canceled.length)
})

test('smoke failure diagnostics redact the application token echoed by an executor', async t => {
  const { runProductionCiSmoke } = await import('./install-ci-smoke.mjs')
  const token = 'smoke-test-credential'
  const f = await fixture(t, 'credential-echo', token)
  await assert.rejects(runProductionCiSmoke({ ...options, origin: f.origin,
    release: await releaseFixture(t), token }), error => {
    assert.match(error.message, /Executor echoed \[redacted\]/)
    assert.ok(!error.message.includes(token))
    return true
  })
})


test('deploy smoke waits for updating Workers before admitting every local computer', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t, undefined, undefined, { updatingDiscoveries: 3 })
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.deepEqual(f.admissions.filter(input => input.smokeComputer).map(input => input.smokeComputer),
    [f.computers[0], f.computers[1], f.computers[2], f.computers[4]].map(computer => computer.hostRef))
})

test('deploy smoke completes once CI and health checks pass without a minimum soak', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t)
  await runInstallCiSmoke({ ...options, origin: f.origin, timeoutMs: 500 })
  assert.equal(f.admissions.length, 6)
  assert.ok(f.probes() > 0)
})
