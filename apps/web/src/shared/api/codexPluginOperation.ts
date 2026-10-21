import { errorMessage } from '../errorMessage'
import type { CodexPluginChangeInput, CodexPluginChangeResult, CodexPluginOperation } from '@foreman-code/contracts/management'

export type PluginOperation = {
  commandId: string
  input: CodexPluginChangeInput | null
  requestedBy?: string
  phase: 'sending' | 'retry' | 'review'
  uncertainDelivery: boolean
  result?: CodexPluginChangeResult
  error?: string
}
export function reservePluginOperation(input: CodexPluginChangeInput): PluginOperation {
  return { commandId: input.commandId, input: structuredClone(input), phase: 'sending', uncertainDelivery: false }
}
export function restorePluginOperation(value: CodexPluginOperation): PluginOperation {
  return { commandId: value.commandId, input: value.input, requestedBy: value.requestedBy,
    phase: 'review', uncertainDelivery: true, result: value.result }
}
export function terminalPluginResult(result: CodexPluginChangeResult): boolean { return result.status !== 'uncertain' }
export function pluginOperationSucceeded(current: PluginOperation, result: CodexPluginChangeResult): PluginOperation | null {
  return terminalPluginResult(result) ? null : { ...current, phase: 'review', uncertainDelivery: true, result, error: '' }
}
export function pluginOperationFailed(current: PluginOperation, error: unknown): PluginOperation | null {
  // Only these service preflight errors prove non-acceptance. An authorization
  // failure can occur after a receipt committed, so 401/403 are never proof.
  const preflightCodes = ['REVISION_CONFLICT', 'CODEX_PLUGIN_ARTIFACT_REQUIRED',
    'CODEX_PLUGIN_INSTALL_UNAVAILABLE', 'CODEX_PLUGIN_REMOVE_UNAVAILABLE', 'CODEX_PLUGIN_NOT_FOUND',
    'CODEX_PLUGIN_CONFIG_UNAVAILABLE', 'CODEX_PLUGIN_RECOVERY_REQUIRED',
    'MCP_SETTINGS_BUSY', 'MCP_RECONCILIATION_REQUIRED', 'CODEX_PLUGIN_RECONCILIATION_REQUIRED']
  const definite = error && typeof error === 'object' && 'code' in error && 'status' in error
    && error.status === 409 && preflightCodes.includes(String(error.code))
  // Once delivery is uncertain, no later 4xx can erase the original command.
  if (definite && !current.uncertainDelivery && !current.result) return null
  return { ...current, phase: 'retry', uncertainDelivery: true,
    error: errorMessage(error, 'The result is unknown. Retain the original request.') }
}
