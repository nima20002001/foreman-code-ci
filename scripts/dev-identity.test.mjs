import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiIdentityMatches, webIdentityMatches } from './dev-identity.mjs'
const ok = { ok: true }
const identity = { checkoutId: 'checkout-a', databaseId: 'database-a', installationId: 'installation-a' }
test('API reuse requires matching checkout, target database, and installation', () => {
  const accepts = apiIdentityMatches(identity)
  assert.equal(accepts(ok, JSON.stringify(identity)), true)
  for (const key of Object.keys(identity)) {
    assert.equal(accepts(ok, JSON.stringify({ ...identity, [key]: 'other' })), false)
  }
  assert.equal(accepts(ok, '{"service":"graphql-api","localDev":true}'), false)
  assert.equal(accepts(ok, '<html>'), false)
  assert.equal(accepts({ ok: false }, JSON.stringify(identity)), false)
})
test('web reuse verifies checkout and effective API target including changed port', () => {
  const accepts = webIdentityMatches('checkout-a', 'http://127.0.0.1:3020')
  assert.equal(accepts(ok, JSON.stringify({ checkoutId: 'checkout-a', apiUrl: 'http://127.0.0.1:3020' })), true)
  assert.equal(accepts(ok, JSON.stringify({ checkoutId: 'checkout-a', apiUrl: 'http://127.0.0.1:3000' })), false)
  assert.equal(accepts(ok, JSON.stringify({ checkoutId: 'checkout-b', apiUrl: 'http://127.0.0.1:3020' })), false)
  assert.equal(accepts(ok, '<script src="/src/main.tsx"></script>'), false)
})
