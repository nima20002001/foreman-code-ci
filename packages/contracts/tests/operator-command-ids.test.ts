import { expect, it } from 'vitest'
import {
  RunStopInputSchema, WorkspaceCreateInputSchema, WorkflowCreateInputSchema,
} from '../src/management/index.js'
import { CreateOperatorConversationRequestSchema } from '../src/index.js'
import { ProviderAccountCommandInputSchema } from '../src/providerAccounts.js'
import { ScheduleDisableInputSchema } from '../src/schedules.js'
import { RunSubagentInterruptSchema } from '../src/subagents.js'
import { CodexPluginReconcileInputSchema } from '../src/management/codexPlugins.js'

const callerCommandId = '00000000-0000-4000-8000-000000000001'

it.each([
  [CreateOperatorConversationRequestSchema, { title: 'Conversation' }],
  [ProviderAccountCommandInputSchema, { expectedRevision: 0 }],
  [ScheduleDisableInputSchema, { workspaceId: 'workspace', workflowId: 'workflow', expectedRevision: 0 }],
  [RunSubagentInterruptSchema, { workspaceId: 'workspace', runId: 'run', subagentId: 'child', expectedRevision: '1' }],
  [CodexPluginReconcileInputSchema, {}],
  [RunStopInputSchema, { workspaceId: 'workspace', runId: 'run' }],
  [WorkspaceCreateInputSchema, { name: 'Project' }],
  [WorkflowCreateInputSchema, { workspaceId: 'workspace', name: 'Workflow' }],
] as const)('generates omitted command IDs and preserves explicit retry identities', (schema, input) => {
  const first = schema.parse(input)
  const second = schema.parse(input)
  expect(first.commandId).toMatch(/^[a-f0-9-]{36}$/)
  expect(second.commandId).not.toBe(first.commandId)
  expect(schema.parse({ ...input, commandId: callerCommandId }).commandId).toBe(callerCommandId)
  expect(schema.safeParse({ ...input, commandId: '' }).success).toBe(false)
})
