import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveLintAllowlist } from './lint-allowlist.mjs'

test('legacy exemptions follow renames without exempting replacement files', t => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'lint-identities-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_EMAIL: 'fixture@example.org' })
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  git('init', '-q')
  const legacy = 'export const first = 1\nexport const second = 2\nexport const third = 3\n'
  const peer = 'export const peer = 1\n'
  const id = text => createHash('sha256').update(text).digest('hex')
  writeFileSync(join(root, 'legacy.ts'), legacy)
  writeFileSync(join(root, 'peer.ts'), peer)
  git('add', '.')
  git('commit', '-qm', 'Baseline')
  const allowlist = { files: { [id(legacy)]: 'legacy.ts', [id(peer)]: 'peer.ts' },
    eslint: { 'foreman/no-raw-transactions': [id(legacy)] }, 'test-names': [id(legacy)],
    'import-cycles': [[id(legacy), id(peer)]] }
  git('mv', 'legacy.ts', 'renamed.ts')
  writeFileSync(join(root, 'legacy.ts'), 'export const replacement = true\n')
  const resolved = resolveLintAllowlist(root, allowlist)
  assert.deepEqual(resolved.eslint['foreman/no-raw-transactions'], ['renamed.ts'])
  assert.deepEqual(resolved['test-names'], ['renamed.ts'])
  assert.deepEqual(resolved['import-cycles'], [['renamed.ts', 'peer.ts']])
  git('rm', 'peer.ts')
  assert.deepEqual(resolveLintAllowlist(root, allowlist)['import-cycles'], [])
})
