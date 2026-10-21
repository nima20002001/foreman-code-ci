import assert from 'node:assert/strict'
import { AgentHarnessSchema } from '@foreman-code/contracts'

export function selectedNativeHarnesses() {
  const harnesses = AgentHarnessSchema.array().min(1).max(2).parse(
    JSON.parse(process.env.FOREMAN_CODE_TEST_HARNESSES ?? '["codex","claude"]'))
  assert.equal(new Set(harnesses).size, harnesses.length)
  return harnesses
}
