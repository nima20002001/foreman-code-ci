import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-user-systemd.sh', import.meta.url))

function probe(t, failed = '') {
  const root = process.env.TMPDIR ?? join(homedir(), '.cache/foreman-tmp')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'ci-systemd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = join(directory, 'calls.jsonl')
  writeFileSync(calls, '')
  for (const command of ['sudo', 'systemctl', 'systemd-run', 'loginctl', 'id']) {
    writeFileSync(join(directory, command), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const { basename } = require('node:path')
const command = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS, JSON.stringify({ command, args,
  runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS }) + '\\n')
if (command === 'id') console.log(args[0] === '-u' ? '1001' : 'ci-user')
if (command === process.env.FAILED_COMMAND) process.exit(1)
`, { mode: 0o755 })
  }
  const result = spawnSync('bash', ['-eu', script], { encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`,
      CALLS: calls, FAILED_COMMAND: failed } })
  return { result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('cloud setup enables linger and proves a delegated service on the same user bus as the tests', t => {
  const { result, calls } = probe(t)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /delegated user service probe passed/)
  assert.ok(calls.some(call => call.command === 'sudo'
    && call.args.join(' ') === '-n loginctl enable-linger ci-user'))
  assert.ok(calls.some(call => call.command === 'sudo'
    && call.args.join(' ') === '-n systemctl start user@1001.service'))
  const service = calls.find(call => call.command === 'systemd-run')
  assert.equal(service.runtime, '/run/user/1001')
  assert.equal(service.bus, 'unix:path=/run/user/1001/bus')
  assert.deepEqual(service.args.slice(0, 5), ['--user', '--wait', '--collect', '--quiet', '--property=Delegate=yes'])
  assert.equal(service.args.at(-1), '/usr/bin/true')
})

test('an executor without a system manager fails with a reason before changing its user session', t => {
  const { result, calls } = probe(t, 'systemctl')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no running system manager/)
  assert.equal(calls.some(call => call.command === 'sudo'), false)
})

test('an executor that cannot start its user manager fails before probing or running integration', t => {
  const { result, calls } = probe(t, 'sudo')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /could not start the user manager/)
  assert.equal(calls.some(call => call.command === 'systemd-run'), false)
})

test('a failed delegated service fails setup with a reason instead of skipping systemd tests', t => {
  const { result } = probe(t, 'systemd-run')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /delegated user service probe failed/)
})
