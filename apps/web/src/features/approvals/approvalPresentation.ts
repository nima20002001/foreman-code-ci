import type { DurableInteraction, ApprovalInboxView } from '@foreman-code/contracts'

export function approvalStatuses(view: ApprovalInboxView): DurableInteraction['status'][] {
  if (view === 'delivery') return ['decided', 'delivery_pending', 'delivery_failed']
  if (view === 'history') return ['delivered', 'canceled']
  return ['pending']
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Best-effort display of provider-supplied facts; never invent a command, target, or safety guarantee. */
export function summarizeApprovalRequest(value: DurableInteraction['request'], nativeRequestType = '') {
  if (nativeRequestType === 'workflow/work_direction') return {
    operation: 'Choose direction for the remaining findings', explanation: 'Finish with findings, continue with direction, or stop.',
  }
  const request: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const metadata: Record<string, unknown> = request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
    ? request.metadata as Record<string, unknown> : {}
  const args = Array.isArray(request.command) && request.command.every((arg) => typeof arg === 'string') ? request.command : []
  const command = text(request.command) ?? text(metadata.command)
    ?? (args.length ? args.map((arg) => /^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ') : undefined)
  const permission = text(request.permission)
  const tool = text(request.tool) ?? text(request.toolName)
  const operation = command || nativeRequestType === 'item/commandExecution/requestApproval' || permission === 'bash' || permission === 'shell'
    ? 'Run a command'
    : nativeRequestType === 'item/fileChange/requestApproval' || permission === 'edit' || permission === 'write'
      ? 'Change files'
      : permission === 'external_directory' ? 'Access an external directory'
        : tool ? `Call tool ${tool}` : permission ? `Request ${permission} permission` : 'Review a requested operation'
  const patterns = strings(request.patterns)
  const target = text(request.path) ?? text(request.filePath) ?? text(request.grantRoot) ?? text(request.cwd) ?? text(request.server)
    ?? (patterns.length ? patterns.join(', ') : undefined)
  return { operation, command, target, explanation: text(request.reason) ?? text(request.description) }
}
