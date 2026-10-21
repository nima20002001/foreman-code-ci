import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

export const br2001Providers = ['codex', 'claude'] as const
export type Br2001Provider = typeof br2001Providers[number]

/** Synthetic immutable records only; no model, permission or rollout settings are written. */
export function br2001Fixture(provider: Br2001Provider, suffix: string) {
  const fixture = makeCurrentWorkflowFixture(suffix)
  if (provider === 'claude') fixture.configurations = fixture.configurations.map(configuration =>
    AgentConfigurationVersionSchema.parse({ ...configuration, harness: {
      harness: 'claude', model: 'synthetic-model', authMode: 'subscription',
      permissionMode: 'default', sandbox: 'danger-full-access', configDirectory: '/fixture/profile',
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } }))

  fixture.version = agentWorkflowVersion(ExecutableWorkflowV3Schema.parse({
    configurations: fixture.configurations,
    version: { ...fixture.version, definition: { ...fixture.version.definition,
      nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? {
        ...node, name: 'Tester', choice: { outcomes: [
          { outcome: 'pass', target: { kind: 'branch_end' } },
          { outcome: 'issues', target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } },
        ] },
      } : { ...node, name: 'Fixer' }),
    } },
  }).version)
  const executions = fixture.identities.map((identity) => HarnessExecutionSchema.parse({
    id: identity.executionId, runId: fixture.run.id, workflowNodeId: identity.workflowNodeId,
    agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: identity.attempt, input: {}, state: 'queued', createdAt: fixture.createdAt,
  }))
  return { ...fixture, executions }
}

export function br2001Text(outcome = 'pass', data: unknown = null): string {
  return JSON.stringify({ routing: { outcome }, data })
}

export function br2001Terminal(execution: HarnessExecution, provider: Br2001Provider, text: string) {
  const session = { harness: provider, providerVersion: 'synthetic-br2-001-no-native-call',
    nativeSessionId: `${provider}-${execution.id}` }
  const result = { outcome: 'succeeded' as const, output: { text } }
  return { session, result, execution: HarnessExecutionSchema.parse({
    ...execution, nativeSessionId: session.nativeSessionId, state: 'completed', result,
    finishedAt: new Date().toISOString(),
  }) }
}

export const br2001InvalidTexts = [
  { name: 'ordinary prose', text: 'The review passed.' },
  { name: 'prose around JSON', text: `Result: ${br2001Text()} All done.` },
  { name: 'Markdown', text: `\`\`\`json\n${br2001Text()}\n\`\`\`` },
  { name: 'partial JSON', text: '{"routing":{"outcome":"pass"},"data":' },
  { name: 'extra envelope field', text: '{"routing":{"outcome":"pass"},"data":null,"extra":true}' },
  { name: 'extra routing field', text: '{"routing":{"outcome":"pass","edgeId":"other"},"data":null}' },
  { name: 'undeclared outcome', text: br2001Text('undeclared') },
  { name: 'missing data', text: '{"routing":{"outcome":"pass"}}' },
  { name: 'second JSON value', text: `${br2001Text()}${br2001Text('issues')}` },
  { name: 'double encoded JSON', text: JSON.stringify(br2001Text()) },
  { name: 'empty text', text: '' },
  { name: 'null instead of envelope', text: 'null' },
  { name: 'oversized text', text: br2001Text('pass', 'x'.repeat(64 * 1024)) },
  { name: 'oversized JSON whitespace', text: ' '.repeat(64 * 1024) + br2001Text() },
  { name: 'oversized UTF-8 below character limit', text: br2001Text('pass', '😀'.repeat(17000)) },
] as const
