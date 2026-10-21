import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { captureVerificationInventory } from './verification-runner.mjs'
import { executionDurations } from './ci-selection.mjs'
import { integrationDurationsPath } from './test-integration.mjs'

function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'repository-inventory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps'))
  mkdirSync(join(root, 'packages'))
  mkdirSync(join(root, 'scripts/nested'), { recursive: true })
  return root
}

test('script inventory discovers unlisted top-level and nested tests', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foreman-code', scripts: {
    'test:scripts': 'node --test scripts/listed.test.mjs',
  } }))
  for (const file of ['packages/contracts/src/fixture.test.ts', 'apps/api/src/fixture.test.ts',
    'apps/web/src/fixture.test.tsx', 'apps/worker/test/fixture.test.mjs']) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  const files = ['scripts/listed.test.mjs', 'scripts/unlisted.test.mjs', 'scripts/nested/helper.test.mjs']
  for (const file of files) writeFileSync(join(root, file), '')
  writeFileSync(join(root, 'scripts/nested/helper.mjs'), '')
  const inventory = captureVerificationInventory(root, 'unit').find(portion => portion.key === 'root:test:scripts')
  assert.deepEqual(inventory.files, files.sort())
})

test('CI uses learned durations and ignores obsolete repository snapshots', t => {
  const root = fixture(t)
  for (const suite of ['unit', 'integration']) {
    writeFileSync(join(root, `scripts/${suite}-durations.json`), JSON.stringify({ obsolete: 999 }))
    assert.deepEqual(executionDurations(suite, root, { measured: 12 }), { measured: 12 })
  }
  writeFileSync(join(root, 'scripts/ci-learned-durations.json'), JSON.stringify({ snapshot: 25 }))
  assert.deepEqual(executionDurations('integration', root, { measured: 12 }), { snapshot: 25 })
})

test('integration expectations use the retained snapshot unless explicitly overridden', () => {
  const snapshot = fileURLToPath(new URL('./ci-learned-durations.json', import.meta.url))
  assert.equal(integrationDurationsPath({}), existsSync(snapshot) ? snapshot : null)
  assert.equal(integrationDurationsPath({ FOREMAN_CODE_INTEGRATION_DURATIONS: '/runs/durations.json' }),
    '/runs/durations.json')
})
