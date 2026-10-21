import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARNESS_DEFAULTS, HarnessConfigurationSchema, changeCodexSandbox,
  prepareHarnessConfiguration, withAdvancedDefaults,
} from '../src/index.js';
import type { ClaudeHarnessConfiguration } from '../src/claude.js';
import { GraphDraftOperationSchema } from '../src/management/index.js';

describe('PR12 provider editing contracts', () => {
  it('materializes legacy Codex Advanced without changing the source', () => {
    const legacy = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex);
    delete legacy.advanced;
    const normalized = withAdvancedDefaults(legacy);
    expect(normalized.advanced).toBeDefined();
    expect(HarnessConfigurationSchema.safeParse(normalized).success).toBe(true);
    expect(legacy.advanced).toBeUndefined();
  });
  it('preserves Claude policy without changing the source during editing', () => {
    const configuration: ClaudeHarnessConfiguration = {
      harness: 'claude', model: 'custom-model', effort: 'high', authMode: 'subscription',
      configDirectory: '/profile', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: ['Read'], permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: 'Keep this policy.', mcpServers: {},
    };
    const normalized = withAdvancedDefaults(configuration);
    expect(normalized).toEqual(configuration);
    expect(prepareHarnessConfiguration(configuration)).toEqual(configuration);
    normalized.permissionRules[0]!.effect = 'deny';
    expect(configuration.permissionRules[0]!.effect).toBe('ask');
  });
  it.each(['read-only', 'danger-full-access'] as const)('removes workspace-write-only permissions when selecting %s', (sandbox) => {
    const original = withAdvancedDefaults({ ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' });
    original.advanced!.additionalWritableDirectories = ['/project with spaces '];
    original.advanced!.workspaceWrite = { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    const changed = changeCodexSandbox(original, sandbox);
    expect(changed.advanced?.workspaceWrite).toBeUndefined();
    expect(changed.advanced?.additionalWritableDirectories).toEqual([]);
    expect(HarnessConfigurationSchema.safeParse(changed).success).toBe(true);
    expect(original.advanced?.additionalWritableDirectories).toEqual(['/project with spaces ']);
  });
  it('removes only empty editing separators and preserves path characters', () => {
    const value = withAdvancedDefaults({ ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' });
    value.advanced!.additionalWritableDirectories = ['/one ', '', '/two', ''];
    const saved = prepareHarnessConfiguration(value);
    expect(saved.harness === 'codex' && saved.advanced?.additionalWritableDirectories).toEqual(['/one ', '/two']);
    expect(value.advanced!.additionalWritableDirectories).toEqual(['/one ', '', '/two', '']);
  });
  it('accepts draft approval changes, incomplete designation, and explicit creation overrides', () => {
    expect(GraphDraftOperationSchema.parse({ type: 'workflow.set_approval', approval: { handler: 'orchestrator' } })).toMatchObject({ approval: { handler: 'orchestrator' } });
    expect(GraphDraftOperationSchema.safeParse({ type: 'workflow.set_approval', approval: { handler: 'user', designatedOrchestratorAgentId: 'invalid' } }).success).toBe(false);
    expect(GraphDraftOperationSchema.parse({ type: 'agent.add', agentId: 'coder', nodeId: 'node', name: 'Coder', productRole: 'coder' })).not.toHaveProperty('harness');
    expect(GraphDraftOperationSchema.parse({ type: 'agent.add', agentId: 'coder', nodeId: 'node', name: 'Coder', configuration: DEFAULT_HARNESS_DEFAULTS.codex })).toHaveProperty('configuration');
    expect(GraphDraftOperationSchema.safeParse({ type: 'agent.add', agentId: 'operator', nodeId: 'node', name: 'Operator', productRole: 'operator' }).success).toBe(false);
  });
});
