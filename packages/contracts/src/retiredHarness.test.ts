import { describe, expect, it } from 'vitest';
import {
  AgentConfigurationVersionSchema,
  AgentHarnessSchema,
  AgentSchema,
  HarnessConfigurationSchema,
  SupportedHarnessConfigurationSchema,
  RecordedOperatorChatSettingsSchema,
} from './index.js';
import { RecordedHarnessQualificationSchema, HarnessQualificationSchema } from './harnessQualification.js';
import { AgentConversationSchema } from './agentChat.js';
import {
  AgentCreateInputSchema,
  HarnessGetInputSchema,
  NativeConfigurationCheckInputSchema,
} from './management/index.js';

const retired = {
  harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max',
  nativeAgent: 'build', thinking: false, autoApprove: false,
};

describe('retired harness history', () => {
  it('preserves saved Agent settings and immutable configuration facts', () => {
    expect(HarnessConfigurationSchema.parse(retired)).toEqual(retired);
    const agent = { id: 'agent-history', name: 'Saved Agent', harness: 'opencode', harnessConfiguration: retired };
    expect(AgentSchema.parse(agent)).toEqual(agent);
    const version = {
      id: 'configuration-history', workspaceId: 'workspace-history', agentId: agent.id,
      version: 1, prompt: {}, assignedSkills: [], harness: retired,
      contentHash: 'sha256:retained-original-hash', createdAt: '2026-10-01T00:00:00.000Z',
    };
    expect(AgentConfigurationVersionSchema.parse(version)).toEqual(version);
  });

  it('rejects OpenCode as a new harness choice through shared HTTP and MCP inputs', () => {
    expect(AgentHarnessSchema.options).toEqual(['codex', 'claude']);
    expect(SupportedHarnessConfigurationSchema.safeParse(retired).success).toBe(false);
    expect(AgentCreateInputSchema.safeParse({
      workspaceId: 'workspace-history', commandId: 'create-retired-agent', agentId: 'agent-new',
      name: 'New Agent', configuration: retired,
    }).success).toBe(false);
    expect(HarnessGetInputSchema.safeParse({ harness: 'opencode' }).success).toBe(false);
    expect(NativeConfigurationCheckInputSchema.safeParse({ configuration: retired }).success).toBe(false);
  });

  it('retains saved conversation controls, native session identity and qualification profile', () => {
    const settings = { harness: 'opencode', model: retired.model, variant: retired.variant, showThinking: true };
    expect(RecordedOperatorChatSettingsSchema.parse(settings)).toEqual(settings);
    const conversation = {
      id: 'chat-history', workspaceId: 'workspace-history', workflowId: 'workflow-history',
      workflowNodeId: 'node-history', agentId: 'agent-history', agentConfigurationVersionId: 'configuration-history',
      harness: 'opencode', origin: { kind: 'fresh' },
      nativeSession: { nativeSessionId: 'native-history', providerVersion: '1.18.31' },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(AgentConversationSchema.parse(conversation)).toEqual(conversation);
    const qualification = {
      harness: 'opencode', version: '1.18.31', binarySha256: null, status: 'qualified', profile: 'opencode-1.18.31',
      suiteRevision: 'retained-suite', checks: [], failureReason: null,
      startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:00:01.000Z',
    };
    expect(RecordedHarnessQualificationSchema.parse(qualification)).toEqual(qualification);
    expect(HarnessQualificationSchema.safeParse(qualification).success).toBe(false);
  });
});
