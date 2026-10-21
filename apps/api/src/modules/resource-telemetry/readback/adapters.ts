import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { TelemetryReadResultSchema, TelemetrySelectorSchema, type TelemetryReadService } from '@foreman-code/contracts/resource-telemetry'
import { DomainError } from '../../errors.js'
export const RESOURCE_TELEMETRY_READ_TOOL = 'resource_telemetry_read' as const
export const RESOURCE_TELEMETRY_READ_ROUTE = '/api/management/resource-telemetry/read' as const
export interface TelemetryDenialAudit {
  record(principalId: string, source: 'http' | 'mcp', selectorKey: string): Promise<void>
}
/** Both adapters use identical parsing, authorization, projection and non-disclosure. */
export async function readTelemetry(service: TelemetryReadService<ManagementPrincipal>, principal: ManagementPrincipal,
  input: unknown, signal: AbortSignal, source: 'http' | 'mcp', audit: TelemetryDenialAudit) {
  const parsed = TelemetrySelectorSchema.safeParse(input)
  if (!parsed.success) throw new DomainError('INVALID_REQUEST', 'The telemetry selector does not match its shared contract.', 400)
  const selector = parsed.data
  const result = TelemetryReadResultSchema.parse(await service.read(principal, selector, signal))
  if (result.kind === 'denied') await audit.record(principal.id, source, result.selectorKey)
  return result
}
