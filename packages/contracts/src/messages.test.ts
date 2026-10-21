import { describe, expect, it } from 'vitest';
import { MessageSchema as RootMessageSchema, RecordedAgentHarnessSchema as RootHarnessSchema,
  AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, ExecutionResultSchema, agentTemplateForRole,
  AgentIdentitySchema, AgentSubjectSchema, agentProductRoleLabel, collaborationContractFixtures as fixture } from './index.js';
import { MessageSchema, NativeSourceMessageSchema } from './messages.js';
import { RecordedAgentHarnessSchema } from './harnessIdentity.js';
import { AgentChatStateSchema, agentChatFixtures, AgentChatSourceTranscriptSchema } from './agentChat.js';
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from './wave25/saved.js';
import { makeCurrentWorkflowFixture } from './wave25/currentFixture.js';
import { AgentSettingsSearchSchema } from './management/settingsExperience.js';

describe('shared message and identity compatibility', () => {
  it.each(Object.entries(agentChatFixtures))('preserves the existing %s conversation fixture', (_name, value) => {
    expect(AgentChatStateSchema.parse(value)).toEqual(value);
    for (const message of value.messages) expect(MessageSchema.parse(message)).toEqual(RootMessageSchema.parse(message));
  });

  it('retains native message identity without inventing a conversation', () => {
    const source = { ...fixture.nativeMessage, nativeMessageId: 'native-id', nativeParentMessageId: 'old-opencode-parent' };
    expect(NativeSourceMessageSchema.parse(source)).toEqual(source);
    expect(AgentChatSourceTranscriptSchema.parse({ executionId: 'execution', state: 'running', revision: '2',
      messages: [source], hasEarlierMessages: false }).messages).toEqual([source]);
    expect(MessageSchema.safeParse(source).success).toBe(false);
    expect(NativeSourceMessageSchema.safeParse({ ...source, conversationId: 'fabricated' }).success).toBe(false);
  });

  it.each(['codex', 'claude', 'opencode'])('preserves recorded %s harness identity', (harness) => {
    expect(RecordedAgentHarnessSchema.parse(harness)).toBe(RootHarnessSchema.parse(harness));
  });

  it('keeps stored defaults and historical V3 facts unchanged', () => {
    const stored = structuredClone(DEFAULT_AGENT_DEFAULTS);
    expect(AgentDefaultsSchema.parse(stored)).toEqual(stored);
    expect(AgentDefaultsSchema.parse(stored)).not.toHaveProperty('master');
    expect(agentTemplateForRole(stored, 'master')).toMatchObject({ role: 'master', boardAddable: true });
    expect(stored).not.toHaveProperty('master');
    expect(stored.operator).toMatchObject({ role: 'operator', boardAddable: false });
    const old = makeCurrentWorkflowFixture('compatibility', 'approval');
    expect(WorkflowVersionV3Schema.parse(old.version)).toEqual(old.version);
    expect(WorkflowRunV3Schema.parse(old.run)).toEqual(old.run);
    const result = { outcome: 'succeeded', output: { original: ['business', 3] } };
    expect(ExecutionResultSchema.parse(result)).toEqual(result);
  });

  it('uses explicit graph roles and keeps Operator separate', () => {
    for (const role of ['master', 'orchestrator', 'coder', 'operator']) {
      expect(AgentSettingsSearchSchema.parse({ role })).toEqual({ role });
    }
    expect(agentProductRoleLabel('coder')).toBe('Worker');
    expect(agentProductRoleLabel('master')).toBe('Master');
    expect(AgentIdentitySchema.safeParse({ ...fixture.agent, productRole: 'operator' }).success).toBe(false);
    expect(AgentSubjectSchema.safeParse({ kind: 'coordinator_consultation', agent: fixture.agent, binding: fixture.binding }).success).toBe(true);
    expect(AgentSubjectSchema.safeParse({ kind: 'coordinator_consultation', agent: { ...fixture.agent, productRole: 'coder' }, binding: fixture.binding }).success).toBe(false);
    expect(AgentSubjectSchema.safeParse({ kind: 'coordinator_consultation', agent: fixture.agent, binding: { ...fixture.binding, purpose: 'execution' } }).success).toBe(false);
  });
});
