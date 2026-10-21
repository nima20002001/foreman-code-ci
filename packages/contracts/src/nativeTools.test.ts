import { describe, expect, it } from 'vitest';
import { AgentSchema, DEFAULT_AGENT_DEFAULTS } from './index.js';
import { NativeToolsSchema, nativeMcpServerAllowed, nativeToolsSummary } from './nativeTools.js';
import { AgentCreateInputSchema, AgentUpdateInputSchema } from './management/extensions.js';

describe('native tool loading policy', () => {
  it('keeps host behavior when absent and restricts new board role defaults', () => {
    expect(AgentSchema.parse({ id: 'agent', name: 'Agent' }).nativeTools).toBeUndefined();
    expect(nativeMcpServerAllowed('linear')).toBe(true);
    expect(DEFAULT_AGENT_DEFAULTS.coder.nativeTools).toEqual({ mcpServers: [], apps: false });
    expect(DEFAULT_AGENT_DEFAULTS.orchestrator.nativeTools).toEqual({ mcpServers: [], apps: false });
    expect(DEFAULT_AGENT_DEFAULTS.operator.nativeTools).toBeUndefined();
  });

  it('preserves the app connection and independently disables apps', () => {
    const policy = { mcpServers: ['linear'], apps: false };
    expect(nativeMcpServerAllowed('linear', policy)).toBe(true);
    expect(nativeMcpServerAllowed('slack', policy)).toBe(false);
    expect(nativeMcpServerAllowed('codex_apps', policy)).toBe(false);
    for (const name of ['foreman-code', 'graphql']) {
      expect(nativeMcpServerAllowed(name, { mcpServers: [], apps: false })).toBe(true);
    }
    expect(nativeMcpServerAllowed('codex_apps', { mcpServers: [], apps: true })).toBe(false);
    expect(nativeMcpServerAllowed('codex_apps', { mcpServers: ['codex_apps'], apps: true })).toBe(true);
  });

  it('rejects duplicate or unsafe server names', () => {
    for (const mcpServers of [['linear', 'linear'], ['server.enabled'], [''], ['with space']]) {
      expect(NativeToolsSchema.safeParse({ mcpServers }).success).toBe(false);
    }
  });

  it('accepts policy-only MCP updates and explicit host inheritance', () => {
    const input = { workspaceId: 'workspace', agentId: 'agent', commandId: 'command-1',
      expectedRevision: 1, expectedConfigurationVersionId: 'configuration', nativeTools: {} };
    expect(AgentUpdateInputSchema.parse(input).nativeTools).toEqual({});
    expect(AgentCreateInputSchema.parse({ workspaceId: 'workspace', agentId: 'agent',
      name: 'Agent', commandId: 'command-1', nativeTools: { mcpServers: [] } }).nativeTools)
      .toEqual({ mcpServers: [] });
    expect(nativeToolsSummary({ mcpServers: [], apps: false })).toBe('Foreman Code; apps off');
    expect(nativeToolsSummary()).toBe('Host MCP servers; apps inherit host settings');
  });
});
