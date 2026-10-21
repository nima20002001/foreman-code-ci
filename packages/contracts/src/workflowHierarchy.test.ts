import { describe, expect, it } from 'vitest';
import { WorkflowHierarchySchema, WorkflowHierarchyContextSchema, WorkflowDelegationContextSchema } from './workflowHierarchy.js';
import { effectiveGraphqlTools, graphqlRoleTools } from './graphqlMcpTools.js';
import { newAgentMemoryBoardAccess } from './collaborationTools.js';
import { collaborationContractFixtures as fixture } from './collaborationFixtures.js';
import { DEFAULT_AGENT_DEFAULTS, agentTemplateForRole } from './index.js';
import { AgentCreateInputSchema, AgentDefaultsUpdateInputSchema, GraphDraftOperationSchema } from './management/index.js';
import { PublicGraphTopologySchema } from './wave25/graphPrimitives.js';

describe('hierarchy identity and routing contracts', () => {
  const hierarchy = { version: 1, masterNodeId: 'master', parents: [
    { workflowNodeId: 'coordinator', parentNodeId: 'master' }, { workflowNodeId: 'worker', parentNodeId: 'coordinator' },
  ] };
  const nodes = [fixture.agent,
    { ...fixture.agent, workflowNodeId: 'coordinator', agentId: 'agent-coordinator', productRole: 'orchestrator' },
    { ...fixture.agent, workflowNodeId: 'worker', agentId: 'agent-worker', productRole: 'coder' },
  ];
  const context = { hierarchy, workspaceId: 'workspace', workflowId: 'workflow', entryNodeId: 'master', nodes };

  it('requires a complete scoped Master/Orchestrator/Worker tree at executable validation', () => {
    expect(WorkflowHierarchyContextSchema.safeParse(context).success).toBe(true);
    expect(WorkflowHierarchyContextSchema.safeParse({ ...context, nodes: nodes.map((node) => ({ ...node, workflowId: 'other' })) }).success).toBe(false);
    expect(WorkflowHierarchyContextSchema.safeParse({ ...context, entryNodeId: 'coordinator' }).success).toBe(false);
    expect(WorkflowHierarchyContextSchema.safeParse({ ...context, nodes: [...nodes, { ...fixture.agent, workflowNodeId: 'second-master' }] }).success).toBe(false);
    expect(WorkflowHierarchySchema.safeParse({ ...hierarchy, parents: [...hierarchy.parents, hierarchy.parents[0]] }).success).toBe(false);
    expect(WorkflowHierarchySchema.safeParse({ ...hierarchy, parents: [{ workflowNodeId: 'coordinator', parentNodeId: 'worker' }, { workflowNodeId: 'worker', parentNodeId: 'coordinator' }] }).success).toBe(false);
  });

  it('delegates once per distinct saved direct child', () => {
    const request = { hierarchy, parentNodeId: 'master', routing: { kind: 'delegate', requests: [{ outcome: 'review', data: { task: 'Review' } }] },
      routes: [{ outcome: 'review', childNodeId: 'coordinator' }] };
    expect(WorkflowDelegationContextSchema.safeParse(request).success).toBe(true);
    expect(WorkflowDelegationContextSchema.safeParse({ ...request, routes: [{ outcome: 'review', childNodeId: 'worker' }] }).success).toBe(false);
    expect(WorkflowDelegationContextSchema.safeParse({ ...request,
      routing: { kind: 'delegate', requests: [{ outcome: 'review', data: {} }, { outcome: 'review_again', data: {} }] },
      routes: [...request.routes, { outcome: 'review_again', childNodeId: 'coordinator' }] }).success).toBe(false);
  });
});

it('preserves explicit Master identity through authoring, defaults and immutable topology readback', () => {
  const creation = { workspaceId: 'workspace', agentId: 'master-agent', name: 'Master' };
  expect(AgentCreateInputSchema.parse(creation).productRole).toBe('coder');
  expect(AgentCreateInputSchema.parse({ ...creation, productRole: 'master' }).productRole).toBe('master');
  expect(AgentCreateInputSchema.safeParse({ ...creation, productRole: 'operator' }).success).toBe(false);
  const operation = { type: 'agent.add_from_template', template: 'master', productRole: 'master',
    agentId: 'master-agent', nodeId: 'master', name: 'Master' };
  expect(GraphDraftOperationSchema.parse(operation)).toEqual(operation);
  expect(GraphDraftOperationSchema.safeParse({ ...operation, productRole: 'coder' }).success).toBe(false);
  expect(GraphDraftOperationSchema.safeParse({ ...operation, template: 'operator', productRole: 'operator' }).success).toBe(false);
  const topology = { entryNodeId: 'master', nodes: [{ workflowNodeId: 'master', agentId: 'master-agent',
    agentConfigurationVersionId: 'master-config', productRole: 'master' }], relationships: [] };
  expect(PublicGraphTopologySchema.parse(topology)).toEqual(topology);
  const value = { ...DEFAULT_AGENT_DEFAULTS, master: agentTemplateForRole(DEFAULT_AGENT_DEFAULTS, 'master') };
  expect(AgentDefaultsUpdateInputSchema.parse({ value }).value.master?.role).toBe('master');
  expect(AgentDefaultsUpdateInputSchema.parse({ value: DEFAULT_AGENT_DEFAULTS }).value).not.toHaveProperty('master');
  expect(AgentDefaultsUpdateInputSchema.safeParse({ value: { ...value,
    master: { ...value.master, harness: { harness: 'opencode', model: 'old', variant: '',
      nativeAgent: 'build', thinking: true, autoApprove: false } },
  } }).success).toBe(false);
});

it('keeps future tools dormant and preserves legacy absent defaults after handler cutover', () => {
  const implemented = ['memory_board_get', 'memory_card_create'];
  for (const role of ['master', 'orchestrator', 'coder'] as const) {
    expect(graphqlRoleTools(role)).not.toContain('memory_board_get');
    expect(effectiveGraphqlTools(role, ['memory_board_get'])).not.toContain('memory_board_get');
    expect(effectiveGraphqlTools(role, undefined, undefined, false, implemented)).not.toContain('memory_board_get');
    expect(effectiveGraphqlTools(role, ['memory_board_get'], undefined, false, implemented)).toContain('memory_board_get');
  }
  expect(effectiveGraphqlTools('master', ['interaction_respond'])).toEqual(['bug_report', 'interaction_respond']);
  expect(effectiveGraphqlTools('coder', ['interaction_respond'])).toEqual(['bug_report']);
  expect(newAgentMemoryBoardAccess('master')).toBe('write');
  expect(newAgentMemoryBoardAccess('orchestrator')).toBe('write');
  expect(newAgentMemoryBoardAccess('coder')).toBe('read');
});
