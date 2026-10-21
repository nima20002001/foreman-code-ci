import { z } from 'zod'
import { PROVIDER_ACCOUNT_TOOLS } from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../../modules/errors.js'
import { toolFailure } from '../shared/results.js'
import { operatorToolAvailable } from './availability.js'
import type { OperatorRequestContext } from './types.js'

/** Called by the authenticated /mcp dispatcher before SDK handling, for direct calls to
 * registry tools this caller cannot discover. Hidden tools stay hidden; denials are audited. */

const DEVICE_OPERATOR_TOOLS = ['computer_activity_list', 'computer_rename', 'computer_accounts_list', 'computer_github_login_start', 'computer_github_login_status', 'computer_github_logout', 'computer_github_setup_git', 'computer_sync_status', 'computer_sync_update', 'build_computer_get', 'build_computer_update', 'build_computers_update', 'device_main_identity_get', 'devices_list', 'device_pairing_grant_create', 'device_revoke', 'device_setup_code_create', 'device_setup_options_get',
  'device_connection_host_discover', 'device_connection_read', 'device_connection_inspect', 'device_connection_check', 'device_connection_configure'] as const
const DeviceToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(DEVICE_OPERATOR_TOOLS) }).passthrough() }).passthrough()
/** Called by the existing authenticated /mcp dispatcher before SDK handling, including hidden tool calls. */
export async function unavailableDeviceOperatorToolCall(context: OperatorRequestContext, body: unknown) {
  const call = DeviceToolCall.safeParse(body)
  if (!call.success || operatorToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  let serviceAvailable = !!context.services.devices
  if (name === 'computer_activity_list' || name === 'computer_rename') serviceAvailable = !!context.services.computerActivity
  else if (name === 'computer_accounts_list') serviceAvailable = !!context.services.computerAccounts
  else if (name.startsWith('computer_github_')) serviceAvailable = !!context.services.computerGitHub
  else if (name.startsWith('computer_sync_')) serviceAvailable = !!context.services.computerSync
  else if (name.startsWith('build_computer')) serviceAvailable = !!context.services.buildComputers
  else if (name.startsWith('device_connection_')) serviceAvailable = !!context.services.trustedConnections
  let unavailableCode = 'DEVICE_MANAGEMENT_UNAVAILABLE'
  if (name.startsWith('device_connection_')) unavailableCode = 'DEVICE_CONNECTION_UNAVAILABLE'
  if (name.startsWith('computer_sync_')) unavailableCode = 'COMPUTER_SYNC_UNAVAILABLE'
  const error = serviceAvailable
    ? new DomainError('ACCESS_DENIED', 'Device management requires a compatible global settings grant.', 403)
    : new DomainError(unavailableCode, 'The requested device service is not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}

const OPERATOR_CONTROL_TOOLS = ['operator_chat_cancel', 'operator_chat_respond', 'operator_chat_controls_get', 'operator_chat_controls_update', 'agent_chat_controls_get', 'agent_chat_controls_update',
  'agent_chat_ensure_conversation', 'conversation_file_upload', 'conversation_file_finalize',
  'conversation_file_cancel', 'conversation_files_list', 'conversation_file_read'] as const
const ControlToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(OPERATOR_CONTROL_TOOLS) }).passthrough() }).passthrough()

/** Preserve authenticated denial audit for direct calls to grant-hidden controls. */
export async function unavailableOperatorControlToolCall(context: OperatorRequestContext, body: unknown) {
  const call = ControlToolCall.safeParse(body)
  if (!call.success || operatorToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  let composed: unknown = context.services.operatorChat
  if (name.startsWith('agent_chat_')) composed = context.services.agentChat
  if (name.startsWith('conversation_file')) composed = context.services.temporaryFiles
  const error = composed
    ? new DomainError('ACCESS_DENIED', 'The chat operation requires compatible conversation grants.', 403)
    : new DomainError('OPERATOR_CHAT_UNAVAILABLE', 'Operator chat is not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}

const RunToolCallSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum([
    'run_start', 'run_start_resolve', 'run_stop', 'run_handoffs_get_v1', 'run_activities_get_v1', 'run_node_placement_get',
    'run_subagents_list_v1', 'run_subagent_get_v1', 'run_subagent_messages_list_v1', 'run_subagent_tools_list_v1',
    'run_subagent_input_v1', 'run_subagent_interrupt_v1', 'run_subagent_respond_v1',
  ]) }).passthrough(),
}).passthrough()

/** Called only after existing HTTP host/origin and Operator authentication.
 * Hidden tools stay hidden. Their denied invocation cannot bypass audit by
 * falling into an SDK unknown-tool response; no extra grants are issued. */
export async function unavailableRunToolCall(context: OperatorRequestContext, body: unknown) {
  const request = RunToolCallSchema.safeParse(body)
  if (!request.success || operatorToolAvailable(context, request.data.params.name)) return undefined
  const name = request.data.params.name
  const error = context.services.runs
    ? new DomainError('ACCESS_DENIED', 'The Run tool is not permitted by compatible scoped grants.', 403)
    : new DomainError('RUN_SERVICES_UNAVAILABLE', 'Run services are not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: request.data.id, result: toolFailure(error) }
}

export async function unavailableProviderAccountToolCall(context: OperatorRequestContext, body: unknown) {
  const request = body as { id?: unknown; method?: unknown; params?: { name?: unknown } }
  if (request?.method !== 'tools/call' || typeof request.params?.name !== 'string') return undefined
  const name = PROVIDER_ACCOUNT_TOOLS.find(tool => tool === request.params!.name)
  if (!name || operatorToolAvailable(context, name)) return undefined
  await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: request.id,
    result: toolFailure(new DomainError('ACCESS_DENIED', 'The caller is not authorized for this account operation.', 403)) }
}
