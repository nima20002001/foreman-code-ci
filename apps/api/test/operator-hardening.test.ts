import { strict as assert } from 'node:assert'
import { relative, resolve, sep } from 'node:path'
import { test } from 'vitest'

import { parseCredentialArguments } from '../src/cli/operatorCredentialArguments.js'
import { resolveExecutionDirectory } from '../src/modules/runs/executionDirectory.js'

const issue = ['issue', '--name', 'test-operator']

for (const args of [
  [...issue, '--audience', 'workre'],
  [...issue, '--audience'],
  [...issue, '--workspace'],
  [...issue, '--workspace', '--audience', 'worker'],
  [...issue, '--workspace', ''],
  [...issue, '--workspace', '   '],
  [...issue, '--unknown', 'x'],
  [...issue, '--audience', 'worker', '--audience', 'operator'],
  [...issue, 'unexpected'],
  [...issue, '--days', '0'],
  [...issue, '--days', '366'],
  [...issue, '--days', '1.5'],
  [...issue, '--days', '1e2'],
  ['issue'],
  ['revoke'],
  ['revoke', 'principal-1', 'extra'],
  ['revoke', '--workspace'],
  ['unexpected-command'],
]) {
  test(`F28 rejects malformed credential arguments: ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseCredentialArguments(args))
  })
}

test('F28 preserves an explicit narrow workspace and worker audience', () => {
  assert.deepEqual(parseCredentialArguments([...issue, '--workspace', 'workspace-a', '--audience', 'worker', '--days', '7']), {
    command: 'issue', name: 'test-operator', audience: 'worker', days: 7, workspaceId: 'workspace-a',
  })
})

test('Operator credentials default to no expiry and retain explicit revocation', () => {
  assert.deepEqual(parseCredentialArguments(issue), {
    command: 'issue', name: 'test-operator', audience: 'operator', days: null,
  })
  assert.deepEqual(parseCredentialArguments(['revoke', 'principal-1']), { command: 'revoke', principalId: 'principal-1' })
})

const root = resolve('test-execution-root')

test('A01 keeps normal UUID-like execution paths stable', () => {
  assert.equal(resolveExecutionDirectory(root, 'run-1', 'node-1', 1), resolve(root, 'run-1', 'node-1', 'attempt-1'))
})

test('A01 cannot select another run through a traversal node ID', () => {
  const actual = resolveExecutionDirectory(root, 'run-attacker', '../run-victim/node-victim', 1)
  assert.notEqual(actual, resolve(root, 'run-victim', 'node-victim', 'attempt-1'))
  const withinRun = relative(resolve(root, 'run-attacker'), actual)
  assert.ok(withinRun && withinRun !== '..' && !withinRun.startsWith(`..${sep}`))
})

test('A01 encodes run IDs as well as node IDs', () => {
  const actual = resolveExecutionDirectory(root, '../../other-root', '../../other-run', 1)
  const withinRoot = relative(root, actual)
  assert.ok(withinRoot && withinRoot !== '..' && !withinRoot.startsWith(`..${sep}`))
})

test('A01 does not confuse encoded IDs, separators, or dot segments', () => {
  const ids = ['a/b', 'a%2Fb', 'a\\b', '.', '..', 'a.b', 'a%2Eb', '日本語', '/absolute/path']
  const directories = ids.map((id) => resolveExecutionDirectory(root, 'run-1', id, 1))
  assert.equal(new Set(directories).size, ids.length)
})

test('A01 rejects invalid Unicode, empty IDs, and invalid attempts', () => {
  for (const id of ['', '\ud800']) assert.throws(() => resolveExecutionDirectory(root, 'run-1', id, 1))
  for (const attempt of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveExecutionDirectory(root, 'run-1', 'node-1', attempt))
  }
})

test('Worker credentials retain a finite default lifetime', () => {
  assert.deepEqual(parseCredentialArguments([...issue, '--audience', 'worker']), {
    command: 'issue', name: 'test-operator', audience: 'worker', days: 30,
  })
})
