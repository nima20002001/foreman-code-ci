import assert from 'node:assert/strict'
import { test } from 'vitest'
import { native2Fixture } from './eng04-native2-fixtures.js'

const pending = { code: 'REPEAT_CLEANUP_PENDING' }

// The coordinator, closure reader, credential repair and serialized finalizers
// are real. Only the database rows and credential service are explicit doubles.
test('cold terminal replay repairs only captured workflow principals before settlement', async () => {
  const f = native2Fixture(); f.closed()
  f.recovery.bindings.push({ principalId: 'exact-workflow-principal', purpose: 'workflow', revoked: false })
  const before = structuredClone(f.get())
  try {
    assert.equal((await f.observe()).state, 'completed')
    assert.deepEqual(f.calls.filter((call) => call.startsWith('revoke')), ['revoke:exact-workflow-principal'])
    assert.ok(f.calls.lastIndexOf(`settle:${before.id}`) > f.calls.indexOf('revoke:exact-workflow-principal'))
    assert.equal(f.recovery.bindings[0]!.revoked, true)
    assert.equal(f.recovery.statements.filter((q) => q === 'commit').length, 2)
    assert.ok(f.recovery.statements.every((q) => /^(begin|select|commit)\b/.test(q)))
    assert.ok(!f.calls.some((call) => /resolve|createSession|attachSession|startTurn|close:|terminal:/.test(call)))
    assert.deepEqual(f.get(), before)
    const calls = [...f.calls], statements = [...f.recovery.statements]
    await f.observe()
    assert.deepEqual(f.recovery.statements, statements, 'settled replay needs no more resource reads')
    assert.deepEqual(f.calls.slice(calls.length), [`read:${before.id}`, `settle:${before.id}`])
  } finally { await f.connection.close() }
})

test('cold terminal replay never revokes a reviewer principal or bypasses its resource obligation', async () => {
  const f = native2Fixture(); f.closed()
  f.recovery.bindings.push(
    { principalId: 'original-workflow-principal', purpose: 'workflow', revoked: false },
    { principalId: 'successor-reviewer-principal', purpose: 'reviewer', revoked: false },
  )
  const before = structuredClone(f.get())
  try {
    await assert.rejects(f.observe(), pending)
    assert.deepEqual(f.calls.filter((call) => call.startsWith('revoke')), ['revoke:original-workflow-principal'])
    assert.deepEqual(f.recovery.bindings.map((binding) => binding.revoked), [true, false])
    assert.deepEqual(f.get(), before)
    assert.ok(!f.calls.some((call) => /resolve|createSession|attachSession|startTurn|close:|terminal:/.test(call)))
  } finally { await f.connection.close() }
})

test('a changed owner fence rolls back cold credential capture before any revocation', async () => {
  const f = native2Fixture(); f.closed()
  f.recovery.bindings.push({ principalId: 'must-not-revoke', purpose: 'workflow', revoked: false })
  const readFence = f.owner.readOneShotFence
  let reads = 0
  f.owner.readOneShotFence = async (sql) => ({ ...await readFence(sql), fence: String(++reads) })
  try {
    await assert.rejects(f.observe(), pending)
    assert.ok(f.recovery.statements.includes('rollback'))
    assert.ok(!f.recovery.statements.includes('commit'))
    assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
    assert.equal(f.recovery.bindings[0]!.revoked, false)
  } finally { await f.connection.close() }
})

test('a later native generation cannot borrow the original cold credential settlement', async () => {
  const f = native2Fixture(); f.closed()
  f.recovery.bindings.push({ principalId: 'original-workflow-principal', purpose: 'workflow', revoked: false })
  const revoke = f.credentials.revoke
  f.credentials.revoke = async (identity) => {
    await revoke(identity)
    // Fault the read-side generation after the capture transaction committed.
    // Even a matching session/result cannot transfer its generation-41 proof.
    f.getProof()!.durableGeneration = '42'
  }
  const before = structuredClone(f.get())
  try {
    await assert.rejects(f.observe(), pending)
    assert.deepEqual(f.calls.filter((call) => call.startsWith('revoke')), ['revoke:original-workflow-principal'])
    assert.equal(f.recovery.statements.filter((q) => q === 'commit').length, 1)
    assert.ok(f.recovery.statements.includes('rollback'))
    assert.equal(f.calls.filter((call) => call.startsWith('settle:')).length, 1)
    assert.deepEqual(f.get(), before)
  } finally { await f.connection.close() }
})
