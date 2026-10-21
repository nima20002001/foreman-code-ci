import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { HarnessConfiguration, HarnessExecutionRequest } from '@foreman-code/contracts'
import { buildHarnessPrompt, MAX_HARNESS_PROMPT_BYTES } from '../src/modules/harnesses/prompt.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'

const configurations: HarnessConfiguration[] = [
  { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
  { harness: 'claude', model: 'fixture', effort: 'high', authMode: 'subscription',
    permissionMode: 'default', sandbox: 'danger-full-access', configDirectory: '/fixture-profile',
    tools: [], permissionRules: [], instructions: '', mcpServers: {} },
]
function request(harness: HarnessConfiguration, input: HarnessExecutionRequest['input']): HarnessExecutionRequest {
  return { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node',
    workingDirectory: '/accepted-project', runtimeDirectory: '/separate-runtime', input,
    configuration: { id: 'configuration', workspaceId: 'workspace', agentId: 'agent', version: 1,
      prompt: { system: 'Use the supplied input.' }, assignedSkills: [], harness,
      contentHash: 'sha256:fixture', createdAt: '2026-09-17T00:00:00.000Z' } }
}
for (const harness of configurations) {
  for (const predecessor of [false, true]) {
    it(`${harness.harness} retains large ${predecessor ? 'predecessor' : 'initial'} input in its native prompt`, () => {
      const text = 'x'.repeat(300_000)
      const input = predecessor ? { previous: { result: { text } } } : { text }
      const prompt = buildHarnessPrompt(request(harness, input))
      assert.ok(prompt.includes(text))
      assert.ok(prompt.includes('ACCEPTED INPUT FROM THE WORKFLOW'))
    })
  }
  it(`${harness.harness} preserves the 8 MiB prompt limit`, () => {
    assert.throws(() => buildHarnessPrompt(request(harness, { text: 'x'.repeat(MAX_HARNESS_PROMPT_BYTES) })), /8 MiB/)
  })
}
it('missing native Codex binaries fail qualification rather than selecting another execution runtime', async () => {
  await assert.rejects(new NativeHarnessConfigurationQualifier('/not/a/codex-binary')
    .qualify(configurations[0]!, process.cwd()))
})
