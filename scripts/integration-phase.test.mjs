import assert from 'node:assert/strict'
import { test } from 'node:test'
import { integrationPhaseForwarder, integrationPhaseLine } from './integration-phase.mjs'

test('setup summaries identify the file without exposing its parent directory', () => {
  assert.equal(integrationPhaseLine('workspace/test/fixture.integration.test.ts', 'Worker artifact', 12.6),
    '[integration-phase] fixture.integration.test.ts worker-artifact 13')
})

test('job logs receive each summary across arbitrary stdout chunk boundaries', () => {
  const lines = []
  const output = integrationPhaseForwarder(line => lines.push(line))
  output.push('ordinary output\nstdout | fixture\n[integration-')
  output.push('phase] fixture.integration.test.ts worker-artifact 123\n')
  output.push('[integration-phase] fixture.integration.test.ts provider-schemas ')
  output.push('45\nother output\n[integration-phase] fixture.integration.test.ts main-startup 6')
  output.finish()
  output.finish()
  assert.deepEqual(lines, [
    '[integration-phase] fixture.integration.test.ts worker-artifact 123',
    '[integration-phase] fixture.integration.test.ts provider-schemas 45',
    '[integration-phase] fixture.integration.test.ts main-startup 6',
  ])
})

test('ordinary and malformed output remains outside the job summaries', () => {
  const lines = []
  const output = integrationPhaseForwarder(line => lines.push(line))
  output.push('x'.repeat(8192))
  output.push('\n[integration-phase] fixture.integration.test.ts bad -10\n')
  output.push('[integration-phase] fixture.integration.test.ts incomplete\n')
  const escape = String.fromCharCode(27)
  output.push(`${escape}[32m[integration-phase] fixture.integration.test.ts setup 1${escape}[0m\n`)
  output.finish()
  assert.deepEqual(lines, ['[integration-phase] fixture.integration.test.ts setup 1'])
})
