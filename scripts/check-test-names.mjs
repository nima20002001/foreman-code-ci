import { resolveLintAllowlist } from './lint-allowlist.mjs'
// Rejects new test files named after tickets, waves, lanes, rounds or agents instead of the behavior they test.
//   node scripts/check-test-names.mjs
// Names in scripts/lint-allowlist.json ("test-names") predate the check; that list may only shrink.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const ticketSegment = /^(?:(?:eng|nim|wave|wr|pr|sch|rh|agent|round|fix)\d+|w\d\d|lanes?)$/i

/** True when a file name has a segment such as eng03, nim2642, wave2, pr54, w09, lane or round3. */
export function hasTicketName(file) {
  const name = posix.basename(file).replace(testFile, '')
  return name.split(/[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])/).some(segment => ticketSegment.test(segment))
}

export function ticketNamedTests(files, allowed) {
  return files.filter(file => testFile.test(file) && hasTicketName(file) && !allowed.has(file))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const allowed = new Set(resolveLintAllowlist(root, JSON.parse(readFileSync(`${root}/scripts/lint-allowlist.json`, 'utf8')))['test-names'])
  const rejected = ticketNamedTests(files, allowed)
  if (rejected.length) {
    console.error('Name test files after the behavior they cover, not a ticket, wave, lane, round or agent:')
    for (const file of rejected) console.error(`  ${file}`)
    process.exit(1)
  }
}
