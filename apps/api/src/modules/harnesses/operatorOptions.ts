import { asRecord } from '../../shared/records.js'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []
}
function bounded(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new DomainError('HARNESS_CATALOG_INVALID', `${name} is not a bounded native catalog.`, 502)
  return value
}

export function codexModelOptions(value: unknown): HarnessOptions['models'] {
  return bounded(asRecord(value).models, 'models').filter(item => asRecord(item).visibility !== 'hide').map((item) => {
    const model = asRecord(item)
    if (typeof model.slug !== 'string' || !model.slug) throw new DomainError('HARNESS_CATALOG_INVALID', 'A native model has no ID.', 502)
    return {
      id: model.slug,
      ...(Number.isSafeInteger(model.context_window) && Number(model.context_window) > 0
        ? { contextWindow: Number(model.context_window) } : {}),
      ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}),
      reasoningEfforts: strings(bounded(model.supported_reasoning_levels ?? [], 'reasoning levels').map((level) => asRecord(level).effort)),
      variants: [], serviceTiers: ['standard', ...(strings(model.additional_speed_tiers).includes('fast') ? ['priority'] : [])],
      ...(typeof model.priority === 'number' && Number.isFinite(model.priority) ? { defaultPriority: model.priority } : {}),
    }
  })
}

export function harnessSettingSupport(): HarnessOptions['settings'] {
  return [
    {field: 'model', support: 'conditional', detail: 'Choose a model from this native catalog.'},
    {field: 'reasoningEffort', support: 'conditional', detail: 'Must be advertised by the selected model.'},
    {field: 'serviceTier', support: 'conditional', detail: 'Priority requires the native Fast tier.'},
    {field: 'sandbox', support: 'supported', detail: 'read-only, workspace-write, or explicit danger-full-access; no implicit elevation.'},
    {field: 'advanced.approvalPolicy', support: 'supported', detail: 'on-request or never.'},
    {field: 'advanced.approvalsReviewer', support: 'conditional', detail: 'Native auto_review cannot replace Foreman Code-routed workflow approvals.'},
    {field: 'advanced.additionalWritableDirectories', support: 'conditional', detail: 'Only with an explicitly selected workspace-write sandbox.'},
    {field: 'advanced.workspaceWrite', support: 'conditional', detail: 'Only with an explicitly selected workspace-write sandbox.'},
    {field: 'advanced.sessionPersistence', support: 'conditional', detail: 'Resume-dependent workflows require persistent sessions.'},
    {field: 'advanced.shellEnvironment', support: 'supported', detail: 'Passed as the accepted native shell environment policy.'},
    {field: 'advanced.webSearch', support: 'supported', detail: 'disabled, cached, or live.'},
    {field: 'advanced.mcpServers', support: 'conditional', detail: 'Policies must match installed native entries; this does not provision credentials or connections.'},
  ]
}
