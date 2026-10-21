import { z } from 'zod'
import { HarnessCompatibilityListSchema, HarnessCompatibilitySchema, HarnessCompatibilityRetryParamsSchema } from '@foreman-code/contracts'
import { HarnessQualificationListSchema, HarnessQualificationRunParamsSchema, HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'

import {
  ExecutionReadinessInputSchema, ExecutionReadinessSchema,
  HarnessCatalogEntrySchema, HarnessCatalogResultSchema, HarnessDefaultsUpdateInputSchema,
  HarnessDefaultsUpdateResultSchema, HarnessGetInputSchema,
} from '@foreman-code/contracts/management'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'
import { defineOperatorTool } from '../definition.js'

export const harnessTools = [
  defineOperatorTool({
    name: 'claude_setup_options_get',
    requires: [['harnesses:read', 'global']],
    description: 'Read the owning API Foreman Code MCP HTTP endpoint for a pinned Claude configuration. Add it as mcpServers["foreman-code"] (existing graphql entries remain supported) using harness_defaults_update or harness_instance_save. Saving configuration does not qualify execution, grant tools, install packages or change native login files. External MCP servers are rejected because their tool manifests are not supported. Scoped credentials are delivered only at authorized execution admission.',
    inputSchema: z.object({}).strict(), outputSchema: ClaudeSetupOptionsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context) => context.services.harnesses.claudeSetupOptions(context.principal),
  }),
  defineOperatorTool({
    name: 'harness_compatibility_list',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.harnessCompatibility,
    description: 'Read installed Codex versions and runtime protocol verification results, including cached results and unmet contracts. No release catalog, tag, commit or manifest pin is required. Timed-out startup checks retry automatically. Claude SDK compatibility is exposed by harness_get and execution_readiness_get. Authentication and host policy are checked separately.',
    inputSchema: z.object({}).strict(), outputSchema: HarnessCompatibilityListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context) => context.services.harnessCompatibility!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'harness_compatibility_retry',
    requires: [['harnesses:update', 'global']],
    enabled: s => !!s.harnessCompatibility,
    description: 'Recheck the installed Codex version against runtime protocol contracts without a release pin, model turn or settings change. Requires harness update access.',
    inputSchema: HarnessCompatibilityRetryParamsSchema, outputSchema: HarnessCompatibilitySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.harnessCompatibility!.requestRetry(context.principal, 'mcp', input.harness),
  }),
  defineOperatorTool({
    name: 'harness_qualifications_list',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.harnessQualifications,
    description: 'Read persisted exact-binary harness qualification results. Main restores previously qualified Codex binaries after deployment and retries startup inspection timeouts automatically.', inputSchema: z.object({}).strict(),
    outputSchema: HarnessQualificationListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.harnessQualifications!.list(context.principal),
  }),
  defineOperatorTool({
    name: 'harness_qualification_run',
    requires: [['harnesses:update', 'global']],
    enabled: s => !!s.harnessQualifications,
    description: 'Start the app qualification suite for the installed harness binary.', inputSchema: HarnessQualificationRunParamsSchema,
    outputSchema: z.object({ qualification: HarnessQualificationSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (context, input) => context.services.harnessQualifications!.run(context.principal, 'mcp', input.harness),
  }),
  defineOperatorTool({
    name: 'execution_readiness_get',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.executionReadiness,
    description: 'Read native eligibility for workflow harness presets (default scope) or the exact saved Operator configuration (operator-configuration scope). Supply configurationVersionId to inspect a pinned Operator configuration; otherwise inspect its current saved defaults. These scopes have separate host profiles and sandbox policies. No configuration is written or model turn started. Execution still checks workspace, grants, and MCP policy.',
    inputSchema: ExecutionReadinessInputSchema, outputSchema: ExecutionReadinessSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.executionReadiness!.get(context.principal, input.harness, input.scope, input.configurationVersionId),
  }),
  defineOperatorTool({
    name: 'harness_list',
    requires: [['harnesses:read', 'global']],
    description: 'List observed local harness versions, dynamic model catalogs, contract compatibility, '
      + 'saved defaults and application interactionSupport limits. Discovery errors identify unmet contracts. '
      + 'Observation reports the last successful checkedAt, stale/refreshing state, lastError and refresh counters. '
      + 'Only configured presets are listed; unavailable presets keep their harness identity and include a reason. '
      + 'An absent preset does not change existing saved Agents. Use agent_get to read their saved configuration. '
      + 'Codex supports generic questions, MCP approvals, and schema-validated data-entry forms. '
      + 'When native discovery cannot select a default model, capability is null with HARNESS_MODEL_DEFAULT_UNAVAILABLE; '
      + 'choose an explicit native model before using that preset. Claude access choices that need configuration return CLAUDE_FULL_ACCESS_REQUIRED; choose Full access explicitly.',
    inputSchema: z.object({}).strict(),
    outputSchema: HarnessCatalogResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context) => ({ items: await context.services.harnesses.list(context.principal) }),
  }),
  defineOperatorTool({
    name: 'harness_get',
    requires: [['harnesses:read', 'global']],
    description: 'Read the selected harness observed version, dynamic capabilities, saved defaults '
      + 'and application interactionSupport limits. Compatible versions are accepted by contract behavior; '
      + 'Observation reports the last successful checkedAt, stale/refreshing state, lastError and refresh counters. '
      + 'authentication and host policy still apply. '
      + 'A missing Claude preset returns HARNESS_PROFILE_REQUIRED with setup instructions; '
      + 'existing Agents retain their saved harness. '
      + 'Read supported and unsupported descriptions before requesting native input; '
      + 'Codex supports generic questions and schema-validated data-entry forms. '
      + 'An unavailable native default returns capability null and HARNESS_MODEL_DEFAULT_UNAVAILABLE; template values do not qualify execution. Claude presets with unsupported access return capability null and CLAUDE_FULL_ACCESS_REQUIRED until the user explicitly chooses Full access.',
    inputSchema: HarnessGetInputSchema,
    outputSchema: HarnessCatalogEntrySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.harnesses.get(context.principal, input.harness),
  }),
  defineOperatorTool({
    name: 'harness_defaults_update',
    requires: [['harnesses:update', 'global']],
    description: 'Replace defaults copied into future board agents. Omit expectedRevision for last write wins; supply it to reject a stale revision. New, edited or explicitly selected Claude presets accept only explicit Full access and the app MCP connection. Unchanged incomplete Claude presets may be retained while another provider is configured, without changing their access or availability. Use configure to explicitly select a preset even if its template values match. Other unavailable presets stay unavailable. Claude presets persist explicit configuration without native qualification; saving grants no execution or tool authority. Codex selections require their model-free native checks.', inputSchema: HarnessDefaultsUpdateInputSchema,
    outputSchema: HarnessDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.harnesses.updateDefaults(context.principal, 'mcp', input),
  }),
]
