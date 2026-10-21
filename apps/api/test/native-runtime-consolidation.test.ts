import assert from 'node:assert/strict'

import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type HarnessConfiguration, type WorkflowApprovalConfiguration } from '@foreman-code/contracts'

import { it } from 'vitest'

import { assertNativeWorkflowConfiguration } from '../src/modules/harnesses/nativeWorkflowConfiguration.js'

function codex(): Extract<HarnessConfiguration, { harness: 'codex' }> {
  return { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'workspace-write',
    advanced: { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), approvalPolicy: 'on-request' } }
}

function code(expected: string) {
  return (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true }
}

for (const handler of ['user', 'orchestrator'] as const) {
  const approval: WorkflowApprovalConfiguration = { handler,
    ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'reviewer' } : {}) }
  it(`keeps ${handler} routing per Agent while checking explicit Codex self-review`, () => {
    const c = codex()
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(c, approval))
    c.advanced!.approvalsReviewer = 'auto_review'
    if (handler === 'orchestrator') assert.doesNotThrow(() => assertNativeWorkflowConfiguration(c, approval))
    else assert.throws(() => assertNativeWorkflowConfiguration(c, approval), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
  })
}

it('allows native Codex review only for the designated Orchestrator node', () => {
  const reviewer = codex()
  reviewer.advanced!.approvalsReviewer = 'auto_review'
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'reviewer' }
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(reviewer, approval, true))
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(reviewer, approval))
  reviewer.advanced!.approvalPolicy = 'never'
  assert.throws(() => assertNativeWorkflowConfiguration(reviewer, approval, true), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})

it('allows explicit Codex never and auto-review with no routed reviewer, independent of sandbox', () => {
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const never = codex(), review = codex()
    never.sandbox = sandbox; never.advanced!.approvalPolicy = 'never'
    review.sandbox = sandbox; review.advanced!.approvalsReviewer = 'auto_review'
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(never))
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(review))
  }
})

it('requires explicit native settings for every Agent in a native-handled workflow', () => {
  const value = codex()
  assert.throws(() => assertNativeWorkflowConfiguration(value, { handler: 'native' }),
    code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
  value.advanced!.approvalPolicy = 'never'
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(value, { handler: 'native' }))
})

it('uses default native handling for omitted settings without changing saved records', () => {
  const value = codex()
  delete value.advanced
  const before = structuredClone(value)
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(value))
  assert.deepEqual(value, before)
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(value, { handler: 'user' }))
})

it('requires a handler only when the Agent explicitly requests user approval', () => {
  assert.throws(() => assertNativeWorkflowConfiguration(codex()), code('NATIVE_APPROVAL_CONFIGURATION_REQUIRED'))
})

it('refuses incomplete Orchestrator authority and ephemeral routed Codex sessions', () => {
  assert.throws(() => assertNativeWorkflowConfiguration(codex(), { handler: 'orchestrator' }), code('WORKFLOW_APPROVAL_INCOMPLETE'))
  const value = codex(); value.advanced!.sessionPersistence = 'ephemeral'
  assert.throws(() => assertNativeWorkflowConfiguration(value, { handler: 'user' }), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})
