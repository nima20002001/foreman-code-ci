import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readIntegrationResources } from './test-integration.mjs'

const host = { cpuCount: 16, availableMemoryBytes: 32 * 1024 ** 3 }

test('database discovery failure rejects shard planning with a sanitized cause code', async () => {
  const admin = { query: async () => { throw Object.assign(new Error('private connection string'), { code: '08006' }) } }
  await assert.rejects(readIntegrationResources(admin, host), error => {
    assert.match(error.message, /PostgreSQL capacity discovery failed \(08006\)/)
    assert.doesNotMatch(error.message, /private connection/)
    return true
  })
})

test('missing or invalid database capacity cannot become a successful host-only estimate', async () => {
  for (const rows of [[], [{ maxConnections: 0, reservedConnections: 0, activeConnections: 0 }]]) {
    await assert.rejects(readIntegrationResources({ query: async () => ({ rows }) }, host), /PostgreSQL capacity/)
  }
})
