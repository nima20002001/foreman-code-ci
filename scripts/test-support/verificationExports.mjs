import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
const { DOMParser } = require('@xmldom/xmldom')

export function assertJunitCases(directory) {
  const document = new DOMParser().parseFromString(readFileSync(join(directory, 'junit.xml'), 'utf8'), 'text/xml')
  const suites = document.documentElement
  assert.equal(suites.tagName, 'testsuites')
  assert.equal(suites.getAttribute('tests'), '3')
  assert.equal(suites.getAttribute('failures'), '1')
  assert.equal(suites.getAttribute('skipped'), '1')
  const cases = Array.from(document.getElementsByTagName('testcase'))
  assert.deepEqual(cases.map(test => test.getAttribute('name')), ['passes & reports', 'fails <clearly>', 'skips'])
  assert.ok(cases.every(test => test.getAttribute('classname') === 'example.test.mjs'))
  assert.equal(cases[0].childNodes.length, 0)
  assert.equal(cases[1].getElementsByTagName('failure')[0].textContent, 'expected <actual> & failed')
  assert.equal(cases[2].getElementsByTagName('skipped').length, 1)
}

export function assertArchivedLogs(root, directory, log) {
  const extracted = join(root, 'extracted')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', join(directory, 'logs.tar.gz'), '-C', extracted])
  const inventory = JSON.parse(readFileSync(join(extracted, 'archive-index.json'), 'utf8'))
  const entries = readdirSync(join(extracted, 'logs')).map(name => readFileSync(join(extracted, 'logs', name), 'utf8'))
  assert.ok(entries.includes(log))
  assert.ok(entries.includes(readFileSync(join(directory, 'parts', 'apps_api_build.command.json'), 'utf8')))
  assert.equal(inventory.includedFiles, entries.length)
  assert.equal(inventory.truncatedFiles, 0)
  assert.equal(inventory.omittedFiles, 0)
  const parts = join(directory, 'parts')
  assert.equal(inventory.sourceBytes, readdirSync(parts).reduce((bytes, name) => bytes + statSync(join(parts, name)).size, 0))
}
