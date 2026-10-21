import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireWorkerLock, readWorkerStatus } from '../src/runtime.mjs'
import { doctorReport, executableAvailability, hostFacts } from '../src/diagnostics.mjs'
import { workerPath } from '../src/harnessPath.mjs'

async function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'worker-observation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('distinguishes an invalid status response from no listener', async t => {
  const root = await fixture(t)
  assert.equal(await readWorkerStatus(root), null)
  const unlock = await acquireWorkerLock(root, () => ({}))
  t.after(unlock)
  await assert.rejects(readWorkerStatus(root), /status.*invalid/i)
})

test('rejects an oversized status response instead of reporting a stopped Worker', async t => {
  const root = await fixture(t)
  const unlock = await acquireWorkerLock(root, () => ({ active: true, failure: 'x'.repeat(3000) }))
  t.after(unlock)
  await assert.rejects(readWorkerStatus(root), /status.*(large|limit)/i)
})

test('preserves unexpected state directory resolution failures', async t => {
  const root = await fixture(t)
  const loop = join(root, 'loop')
  await symlink(loop, loop)
  await assert.rejects(readWorkerStatus(loop), { code: 'ELOOP' })
})

test('reports storage and executable inspection failures independently', async t => {
  const root = await fixture(t)
  const loop = join(root, 'loop')
  await symlink(loop, loop)
  const facts = await hostFacts(loop, [loop])
  assert.ok(facts.inspectionErrors?.some(error => error.lastError === 'ELOOP'))
  const executables = executableAvailability(loop)
  assert.ok(executables.inspectionErrors?.some(error => error.lastError === 'ELOOP'))
  const report = doctorReport({ facts, executables, service: {}, identity: null })
  assert.ok(report.inspectionErrors.some(error => error.lastError === 'ELOOP'))
})

test('does not silently reject an unreadable optional installation', async t => {
  const root = await fixture(t)
  const bin = join(root, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  const binary = join(bin, 'codex')
  await symlink(binary, binary)
  assert.throws(() => workerPath(root, process.execPath), { code: 'ELOOP' })
})

test('doctor preserves manifest and runtime inspection reasons', () => {
  const errors = ['manifest_missing', 'manifest_unreadable', 'manifest_invalid', 'worker_status_unavailable']
  const report = doctorReport({ facts: {}, identity: null, service: {}, executables: {}, errors })
  assert.deepEqual(report.errors, errors)
})
