import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { HostHarnessOverrideListInputSchema, HostHarnessOverrideListSchema, HostHarnessOverrideSaveSchema, HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckInputSchema, HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { isAuthorized } from '../../access/policy.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { logOperatorToolFailure } from '../../../mcp/operator/invoke.js'
import type { OperatorRequestContext } from '../../../mcp/operator/types.js'
import { DomainError } from '../../errors.js'
import type { HostHarnessOverrideService } from './service.js'

export const HOST_HARNESS_TOOLS = ['harness_instances_list', 'harness_instance_check', 'harness_instance_save'] as const
type HostHarnessToolName = typeof HOST_HARNESS_TOOLS[number]

export function hostHarnessToolAvailable(service: HostHarnessOverrideService | undefined, principal: ManagementPrincipal, name: HostHarnessToolName): boolean {
  if (!service) return false
  if (name === 'harness_instances_list') return isAuthorized(principal, 'harnesses:read')
  if (name === 'harness_instance_save') return isAuthorized(principal, 'harnesses:update')
  return service.qualificationSupported && isAuthorized(principal, 'harnesses:read') && isAuthorized(principal, 'harnesses:update')
}

/** Hidden host tools still receive an authenticated denial; discovery stays grant-filtered. */
export async function unavailableHostHarnessToolCall(context: OperatorRequestContext, body: unknown) {
  const call = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
    method: z.literal('tools/call'), params: z.object({ name: z.enum(HOST_HARNESS_TOOLS), arguments: z.unknown().optional() }).passthrough(),
  }).passthrough().safeParse(body)
  if (!call.success) return undefined
  const name = call.data.params.name, service = context.services.harnessInstances
  if (hostHarnessToolAvailable(service, context.principal, name)) return undefined
  const error = !service
    ? new DomainError('HARNESS_INSTANCES_UNAVAILABLE', 'Host harness settings are not composed.', 503)
    : name === 'harness_instance_check' && isAuthorized(context.principal, 'harnesses:read') && isAuthorized(context.principal, 'harnesses:update')
      ? new DomainError('HARNESS_PROFILE_CHECK_UNAVAILABLE', 'Exact-host profile qualification is not composed.', 503)
      : new DomainError('ACCESS_DENIED', 'The caller is not authorized for this host harness operation.', 403)
  if (error.status === 403) {
    const instance = z.object({ instanceId: z.uuid() }).passthrough().safeParse(call.data.params.arguments)
    const targetKey = name === 'harness_instances_list' ? 'harness-instances'
      : instance.success ? `harness-instance:${instance.data.instanceId}` : `mcp:${name}`
    await context.services.commands.recordDenied(context.principal.id, 'mcp', name, targetKey)
  }
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error, 'Host harness settings failed.') }
}

export function registerHostHarnessOverrideTools(server: McpServer, service: HostHarnessOverrideService, principal: ManagementPrincipal,
  principalForCall = () => principal): void {
  const invoke = async (name: HostHarnessToolName, operation: () => Promise<unknown>) => {
    try {
      return toolResult(await operation())
    } catch (error) {
      logOperatorToolFailure(name, error)
      return toolFailure(error, 'Host harness settings failed.')
    }
  }
  if (hostHarnessToolAvailable(service, principal, 'harness_instances_list')) server.registerTool('harness_instances_list', {
    description: 'Read persisted host-instance overrides separately from global defaults. Enabled saves, Start and placement choices automatically check missing or stale profile results. Main and Workers also check previously qualified profiles after installation updates or reconnects. Installation-only revisions preserve the configuration revision and history. Each profile reports qualifying until its own check finishes. New Run starts report HARNESS_PROFILE_CHECK_PENDING only for profiles selected by that Run and can be retried; other profiles on the computer do not block Start. Failed checks remain unqualified with qualificationFailure. Listing never starts discovery or qualification. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.',
    inputSchema: HostHarnessOverrideListInputSchema, outputSchema: HostHarnessOverrideListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('harness_instances_list', () => service.list(principalForCall(), input, 'mcp')))
  if (hostHarnessToolAvailable(service, principal, 'harness_instance_check')) server.registerTool('harness_instance_check', {
    description: 'Explicitly qualify one exact saved host profile through its admitted native factory/worker. Codex accepts a valid cached model catalog after remote refresh failure when it supports the selected model, reasoning effort and service tier; proof.modelCatalogSource reports cached. Invalid catalogs and unsupported selections fail with their native reason. Claude runs a finite subscription conversation and tool-policy scenarios on disposable files; it consumes subscription capacity. Claude requires Full access and an available Write tool. Other access modes are rejected at save and Start; Full access does not bypass app grants or tool approval. This may start owned diagnostic native processes; listing settings never does. Requires read and update grants; retains idempotent check receipts and exact-target evidence.',
    inputSchema: HostHarnessInstanceCheckInputSchema, outputSchema: HostHarnessInstanceCheckResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('harness_instance_check', () => service.check(principalForCall(), 'mcp', input)))
  if (hostHarnessToolAvailable(service, principal, 'harness_instance_save')) server.registerTool('harness_instance_save', {
    description: 'Create or replace a host-specific harness override. Omit expectedRevision for last write wins; supply it to reject a stale revision. Claude requires Full access; unsupported modes return validation errors and are never upgraded. Writes preserve immutable history; enabled profiles start native qualification automatically. installed/authenticated/qualified remain separate. Start returns retryable HARNESS_PROFILE_CHECK_PENDING while checking; failed checks block with their real reason. No manual harness_instance_check call is required. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.',
    inputSchema: HostHarnessOverrideSaveSchema, outputSchema: HostHarnessOverrideSaveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('harness_instance_save', () => service.save(principalForCall(), 'mcp', input)))
}
