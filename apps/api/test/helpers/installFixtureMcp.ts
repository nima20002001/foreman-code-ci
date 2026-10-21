import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { z } from 'zod'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'

import { HarnessMcpSettingsService } from '../../src/modules/harnesses/mcpSettings.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeMcpAdapter } from '../../src/modules/harnesses/nativeMcpCommon.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { randomUUID } from 'node:crypto'

const Input = z.object({ databaseUrl: z.string().url(), endpoint: z.string().url(),
  directory: z.string().startsWith('/'), recoveryRoot: z.string().startsWith('/'),
  codexBinary: z.string().min(1),
  harnesses: z.array(z.enum(['codex'])).min(1).max(2) }).strict()

function diagnosticAdapter(harness: string, adapter: NativeMcpAdapter): NativeMcpAdapter {
  const recordFailure = (operation: string, error: unknown) => {
    const codes: string[] = []
    let cause = error
    while (cause instanceof Error && codes.length < 5) {
      const code = cause instanceof HarnessExecutionError ? cause.result.error?.code
        : (cause as NodeJS.ErrnoException).code
      codes.push(code && /^[A-Z0-9_]+$/.test(code) ? code : cause.name)
      const frames = cause.stack?.split('\n').filter(line => /^\s+at /.test(line)
        && /\/apps\/api\/src\//.test(line)).slice(0, 3)
      if (frames?.length) console.info(`Managed App MCP ${harness} ${operation} source: ${frames.join(' | ')}`)
      cause = cause.cause
    }
    console.info(`Managed App MCP ${harness} ${operation} failure codes: ${codes.join(' / ')}`)
    throw error
  }
  return {
    read: signal => adapter.read(signal).catch(error => recordFailure('read', error)),
    apply: (snapshot, change, signal, managed) => adapter.apply(snapshot, change, signal, managed)
      .catch(error => recordFailure('apply', error)),
  }
}

/** Executes the normal human-managed installer in the fixture's private process environment. */
export async function installFixtureMcp(file: string) {
  const info = await lstat(file)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o077))
  assert.equal(await realpath(file), file)
  const input = Input.parse(JSON.parse(await readFile(file, 'utf8')))
  const database = new URL(input.databaseUrl)
  const endpoint = new URL(input.endpoint)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && database.pathname.endsWith('_test'))
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && endpoint.pathname === '/mcp')
  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 2 })
  const registry = new NativeProcessRegistry(input.recoveryRoot)
  const owner = `fixture-mcp:${randomUUID()}`
  const closeProcesses = async () => {
    if (registry.snapshot().launches.some(launch => launch.owner === owner) && !await registry.closeOwner(owner)) {
      throw new Error('The native MCP installer processes remain unconfirmed.')
    }
  }
  const settings = new HarnessMcpSettingsService(pool, new PostgresCommandCoordinator(pool), { codex: diagnosticAdapter('codex', new CodexMcpConnections(input.codexBinary, input.directory, registry.scope(owner))) }, () => {}, closeProcesses, input.endpoint)
  try {
    const principal = await new PostgresLocalHumanAccess(pool, new PostgresAccessService(pool)).current()
    assert.equal(new Set(input.harnesses).size, input.harnesses.length)
    for (const harness of input.harnesses) {
      assert.ok(isAbsolute(input.codexBinary))
      const before = await settings.list(principal, harness)
      const installed = await settings.applyManaged(principal, { harness, preset: 'graphql', installed: true,
        expectedRevision: before.revision, commandId: randomUUID() })
      assert.equal(installed.status, 'applied', installed.error ?? 'The normal managed App MCP install did not settle.')
      const current = await settings.list(principal, harness)
      if (current.presets?.graphql === 'disabled') {
        const enabled = await settings.applyManaged(principal, { harness, preset: 'graphql', enabled: true,
          expectedRevision: current.revision, commandId: randomUUID() })
        assert.equal(enabled.status, 'applied')
      }
      assert.equal((await settings.list(principal, harness)).presets?.graphql, 'installed')
    }
  } finally {
    try { await settings.shutdown() } finally { await pool.end() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Supply the private fixture installer input file.')
  await installFixtureMcp(process.argv[2])
}
