import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-worker-imports.mjs', import.meta.url))
const entries = [
  'apps/worker/src/cli.mjs',
  'apps/worker/src/workerFactory.mjs',
  'apps/api/src/modules/byte-transfer/rsyncWriterCli.ts',
  'apps/api/src/modules/harnesses/compatibility/schemaWorker.ts',
]

function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'worker-imports-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const entry of entries) write(entry, 'export {}')
  write('packages/contracts/package.json', JSON.stringify({ exports: {
    './fixture': { import: './dist/fixture.js' },
  } }))
  return { write, run: () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' }) }
}

for (const entry of entries) {
  test(`rejects a transitive database import from ${entry}`, t => {
    const f = fixture(t)
    f.write(entry, "import '@foreman-code/contracts/fixture'")
    f.write('packages/contracts/src/fixture.ts',
      "export * from '../../../apps/api/src/modules/runs/ownerLeases.js'")
    f.write('apps/api/src/modules/runs/ownerLeases.ts',
      "import '../../infrastructure/databaseTimeout.js'")
    f.write('apps/api/src/infrastructure/databaseTimeout.ts', 'export const timeout = 1')
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/infrastructure\/databaseTimeout\.ts/)
    assert.match(result.stderr, /ownerLeases\.ts/)
  })
}

test('accepts runtime cycles and ignores unreachable modules, type imports, comments and strings', t => {
  const f = fixture(t)
  f.write(entries[0], [
    "import './safe.mjs'",
    "// import '../../../apps/api/src/server.ts'",
    'const text = "import \'../../../apps/api/src/server.ts\'"',
  ].join('\n'))
  f.write('apps/worker/src/safe.mjs', "export * from './cli.mjs'")
  f.write(entries[2], [
    "import type { Database } from '../../infrastructure/db.js'",
    "import { type Database } from '../../infrastructure/db.js'",
    "export type { Database } from '../../infrastructure/db.js'",
    "export { type Database } from '../../infrastructure/db.js'",
  ].join('\n'))
  f.write('apps/api/src/infrastructure/db.ts', 'export type Database = unknown')
  f.write('apps/api/src/server.ts', "throw new Error('must not execute imported code')")
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})

test('checks literal dynamic imports bundled into the Worker', t => {
  const f = fixture(t)
  f.write(entries[0], "await import('../../../apps/api/src/production.js')")
  f.write('apps/api/src/production.ts', 'export {}')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/production\.ts/)
})

test('applies the snapshot allowlist to imports outside Worker source directories', t => {
  const f = fixture(t)
  f.write(entries[0], "import '../../../scripts/unlisted.mjs'")
  f.write('scripts/unlisted.mjs', 'export {}')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: scripts\/unlisted\.mjs/)
})

test('follows a JavaScript module with a sibling declaration to the JavaScript the bundler loads', t => {
  const f = fixture(t)
  f.write(entries[2], "import { run } from '../../../../../scripts/verification-runner.mjs'\nrun()")
  f.write('scripts/verification-runner.mjs', 'export function run() {}')
  f.write('scripts/verification-runner.d.mts', 'export declare function run(): void')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})
