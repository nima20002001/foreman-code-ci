import { RECORDED_CODEX_VERSION } from './codex-version.js'
import type { NativeSessionStart } from '../../src/modules/harnesses/port.js'
import { input } from './codex-test-helpers.js'

/** Deterministic source fixtures for the shared production factory. The caller
 * still allocates/authenticates each real application owner and persists facts.
 * These synthetic inputs do not constitute a provider recording or qualification. */
export const codexResponseSurfaceEvidence = {
  origin: 'synthetic' as const,
  redacted: true as const,
  protocolRevision: RECORDED_CODEX_VERSION,
  stableSchemaGitBlob: 'synthetic-stable-schema',
  referenceManifestSha256: 'synthetic-schema-manifest',
}

export function codexResponseSurfaceFixtures(directory: string) {
  const workflow = input(directory, 'workflow-fixture-agent')
  workflow.correlationId = 'workflow-fixture-execution'
  const operator: NativeSessionStart = {
    kind: 'operator', correlationId: 'operator-fixture-conversation', workingDirectory: directory,
    configuration: { id: 'operator-fixture-configuration', operatorId: 'operator-fixture', version: 1,
      harness: structuredClone(workflow.request.configuration.harness), contentHash: 'sha256:operator-fixture',
      createdAt: '2026-10-01T00:00:00.000Z' },
    environment: { agentId: 'operator-fixture', variables: {
      TEST_AGENT_ID: 'operator-fixture', GRAPHQL_MCP_TOKEN: 'synthetic-operator-credential',
    } },
  }
  const agent = input(directory, 'conversation-fixture-agent')
  agent.correlationId = 'agent-fixture-conversation'
  agent.request.executionId = 'agent-fixture-chat-receipt'
  agent.request.runId = 'agent-fixture-chat-provenance'
  delete agent.environment
  const selectedRun = input(directory, 'selected-run-fixture-agent')
  selectedRun.correlationId = 'selected-run-fixture-conversation'
  selectedRun.request.executionId = 'selected-run-fixture-chat-receipt'
  selectedRun.request.runId = 'selected-run-fixture-source-run'
  delete selectedRun.environment
  return [
    { surface: 'workflow' as const, runtimeRole: 'workflow' as const, appMcpAccess: 'scoped' as const,
      source: workflow, inboxAgentId: 'workflow-fixture-agent' },
    { surface: 'operator' as const, runtimeRole: 'operator' as const, appMcpAccess: 'scoped' as const,
      source: operator, inboxAgentId: 'operator-fixture' },
    { surface: 'agent-chat' as const, runtimeRole: 'agent-chat' as const, appMcpAccess: 'none' as const,
      source: agent, inboxAgentId: 'agent-a' },
    { surface: 'selected-run-continuation' as const, runtimeRole: 'agent-chat' as const, appMcpAccess: 'none' as const,
      source: selectedRun, inboxAgentId: 'agent-a',
      selectedRunProvenance: { runId: 'selected-run-fixture-source-run', executionId: 'selected-run-fixture-source-execution' } },
  ]
}
