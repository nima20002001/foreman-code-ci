import { realpath } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import type pg from 'pg'
import { DomainError } from '../errors.js'

// Retain the existing MCP-wide lock as well as canonical file identity.
// This deliberately serializes different harness homes rather than risking lost shared-file writes.
export const NATIVE_SETTINGS_LOCK = 'graphql:harness-mcp-settings'
export async function assertNoUnresolvedPluginWrites(client: pg.PoolClient): Promise<void> {
  const result = await client.query("select 1 from management_command_receipts where operation='codex.plugin.change' and result->>'status'='uncertain' limit 1")
  if (result.rowCount) throw new DomainError('CODEX_PLUGIN_RECONCILIATION_REQUIRED', 'An earlier plugin write is unresolved. Reconcile it in Codex Plugins before another native settings change.', 409)
}
export async function assertNoUnresolvedMcpWrites(client: pg.PoolClient): Promise<void> {
  const result = await client.query("select 1 from harness_mcp_change_plans where status in ('submitting','uncertain') limit 1")
  if (result.rowCount) throw new DomainError('MCP_RECONCILIATION_REQUIRED', 'An earlier native MCP write is unresolved. Reconcile it in MCP settings before changing plugins.', 409)
}
async function canonicalConfigurationPath(file: string): Promise<string> {
  let current = resolve(file)
  const missing: string[] = []
  for (;;) {
    try { return join(await realpath(current), ...missing) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
      missing.unshift(basename(current)); current = dirname(current)
    }
  }
}
export async function lockNativeConfigurationFile(client: pg.PoolClient, file: string): Promise<() => Promise<void>> {
  // Fresh profiles can create a user file. The broad lock stays held
  // while its canonical parent and missing suffix establish the same file key.
  const key = `graphql:native-config:${await canonicalConfigurationPath(file)}`
  const lock = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtext($1)) as locked', [key])
  if (!lock.rows[0]?.locked) throw new DomainError('MCP_SETTINGS_BUSY', 'Another native settings writer owns this configuration file.', 409)
  return async () => {
    const result = await client.query<{ unlocked: boolean }>('select pg_advisory_unlock(hashtext($1)) as unlocked', [key])
    if (!result.rows[0]?.unlocked) throw new Error('Native configuration lock ownership was lost.')
  }
}
