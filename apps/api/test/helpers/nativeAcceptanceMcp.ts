import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { HarnessMcpSettingsService } from '../../src/modules/harnesses/mcpSettings.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { ownedTestDatabaseUrl, ownedTestPath } from './testResources.js'

/** Install the normal managed connection in private profiles; native preflight still verifies it. */
export async function configureNativeAcceptanceMcp(pool: pg.Pool, directory: string,
  binaries: { codex: string }, endpoint: string,
  harnesses: readonly 'codex'[]): Promise<void> {
  ownedTestDatabaseUrl()
  const file = ownedTestPath(join(process.env.CODEX_HOME!, 'config.toml'))
  // Codex requires a user configuration layer before its native settings writer can edit it.
  try { await writeFile(file, '', { mode: 0o600, flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const registry = new NativeProcessRegistry(join(directory, 'native-process-registry'))
  const selected = [...new Set(harnesses)]
  const owners = { codex: `acceptance-mcp:codex:${randomUUID()}` }
  const scopes = {
    codex: selected.includes('codex') ? await registry.reserveLaunch(owners.codex) : registry.scope(owners.codex),
  }
  const service = new HarnessMcpSettingsService(pool, new PostgresCommandCoordinator(pool), {
    codex: new CodexMcpConnections(binaries.codex, directory, scopes.codex),
  }, () => undefined, async () => {
    const closed = await Promise.all(selected.map(async harness => {
      await registry.abandonReservedLaunch(scopes[harness])
      return registry.closeOwner(owners[harness])
    }))
    assert.ok(closed.every(Boolean), 'Native MCP setup closure is unconfirmed.')
  }, endpoint)
  try {
    const authority = await new PostgresAccessService(pool).issue({
      name: 'Native acceptance harness settings', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
    })
    for (const harness of selected) {
      const before = await service.list(authority.principal, harness)
      if (before.presets?.graphql === 'installed') continue
      const plan = await service.applyManaged(authority.principal, {
        harness, preset: 'graphql', installed: true,
        commandId: randomUUID(), expectedRevision: before.revision,
      })
      assert.equal(plan.status, 'applied', JSON.stringify(plan))
      assert.equal((await service.list(authority.principal, harness)).presets?.graphql, 'installed')
    }
  } finally { await service.shutdown() }
}
