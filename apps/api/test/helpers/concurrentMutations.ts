import { setImmediate } from 'node:timers/promises'
import type pg from 'pg'
import type { HarnessConfiguration } from '@foreman-code/contracts'

export async function qualifyConfiguration(configuration: HarnessConfiguration) {
  return { harness: configuration.harness, version: 'fixture', authenticated: true, ready: true,
    structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
    supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }
}

/** Observe a database or pool transition while the competing operation stays gated. */
export async function observe(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error('The controlled mutation did not reach its barrier.')
    await setImmediate()
  }
}

export async function lockWaiter(sql: Pick<pg.Pool, 'query'>, key: string): Promise<boolean> {
  const result = await sql.query<{ waiting: boolean }>(`select exists(
    select 1 from pg_locks where locktype='advisory' and not granted
      and database=(select oid from pg_database where datname=current_database())
      and classid=((hashtext($1)::bigint >> 32) & 4294967295)
      and objid=(hashtext($1)::bigint & 4294967295)) as waiting`, [key])
  return result.rows[0]!.waiting
}
