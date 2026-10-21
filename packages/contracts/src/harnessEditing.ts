import type { ClaudeHarnessConfiguration } from './claude.js';
import {
  AgentEffortSchema,
  DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  SupportedHarnessConfigurationSchema,
  type AgentEffort,
  type CodexHarnessConfiguration,
  type HarnessConfiguration,
} from './index.js';

/** Legacy absence is supported. Never mutate the shared defaults or a saved snapshot. */
export function withAdvancedDefaults(value: CodexHarnessConfiguration): CodexHarnessConfiguration;
export function withAdvancedDefaults(value: ClaudeHarnessConfiguration): ClaudeHarnessConfiguration;
export function withAdvancedDefaults(value: HarnessConfiguration): HarnessConfiguration;
export function withAdvancedDefaults(value: HarnessConfiguration): HarnessConfiguration {
  if (value.harness === 'claude') return structuredClone(value);
  if (value.harness === 'codex') {
    return structuredClone({ ...value, advanced: value.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION });
  }
  return structuredClone(value);
}

/** Empty editor lines are separators, not paths. All other path characters are significant. */
export function prepareHarnessConfiguration(value: HarnessConfiguration): HarnessConfiguration {
  const next = withAdvancedDefaults(value);
  if (next.harness === 'codex' && next.advanced) {
    next.advanced.additionalWritableDirectories = next.advanced.additionalWritableDirectories.filter((path) => path !== '');
  }
  return SupportedHarnessConfigurationSchema.parse(next);
}

/** Tightening/changing a sandbox must not leave incompatible writable permissions behind. */
export function changeCodexSandbox(
  value: CodexHarnessConfiguration,
  sandbox: CodexHarnessConfiguration['sandbox'],
): CodexHarnessConfiguration {
  const next = withAdvancedDefaults({ ...value, sandbox });
  if (sandbox !== 'workspace-write' && next.advanced) {
    next.advanced.additionalWritableDirectories = [];
    delete next.advanced.workspaceWrite;
  }
  return next;
}

/** This projection is optional; a provider variant is not a product effort enum. */
export function legacyEffortForHarness(value: HarnessConfiguration): AgentEffort | undefined {
  return value.harness === 'codex' ? value.reasoningEffort : value.harness === 'opencode' ? AgentEffortSchema.safeParse(value.variant).data : undefined;
}
