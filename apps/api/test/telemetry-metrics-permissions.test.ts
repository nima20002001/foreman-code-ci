import { describe, expect, it } from 'vitest'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { isAuthorized } from '../src/modules/access/policy.js'
import { operatorToolAvailable, operatorToolRequirements } from '../src/mcp/operator/availability.js'
import { OPERATOR_TOOL_ACTIONS } from '../src/mcp/operator/catalog.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

const principal = (actions: ManagementAction[], scope = {}): ManagementPrincipal => ({ id: 'telemetry-reader',
  name: 'Telemetry reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions, scope }] })
const context = (caller: ManagementPrincipal): OperatorRequestContext => ({ principal: caller,
  services: { resourceTelemetry: {} } } as OperatorRequestContext)

describe('explicit host metrics read permission', () => {
  it('does not advertise telemetry for ordinary device readers or scoped host grants', () => {
    for (const name of ['resource_telemetry_read', 'resource_telemetry_selector_get'] as const) {
      expect(operatorToolAvailable(context(principal(['devices:read'])), name)).toBe(false)
      expect(operatorToolAvailable(context(principal(['devices:metrics:read'], { workspaceIds: ['workspace'] })), name)).toBe(false)
      expect(operatorToolAvailable(context(principal(['devices:metrics:read'])), name)).toBe(true)
      expect(OPERATOR_TOOL_ACTIONS.find(tool => tool.name === name)?.action).toBe('devices:metrics:read')
      expect(operatorToolRequirements(name)).toContainEqual({ action: 'devices:metrics:read', scope: 'global' })
      expect(operatorToolRequirements(name).map(requirement => requirement.action)).not.toContain('devices:read')
    }
  })

  it('preserves exact owned-resource alternatives without conferring host access', () => {
    const reader = principal(['runs:read'], { runIds: ['owned-run'] })
    expect(operatorToolAvailable(context(reader), 'resource_telemetry_read', { runId: 'owned-run' })).toBe(true)
    expect(operatorToolAvailable(context(reader), 'resource_telemetry_read', { runId: 'other-run' })).toBe(false)
    expect(isAuthorized(reader, 'devices:metrics:read')).toBe(false)
    const hostReader = principal(['devices:metrics:read'])
    expect(isAuthorized(hostReader, 'runs:read', { runId: 'owned-run' })).toBe(false)
    expect(operatorToolAvailable(context({ ...hostReader, revokedAt: '2026-10-01T00:00:00Z' }), 'resource_telemetry_read')).toBe(false)
  })
})
