import { describe, expect, it } from 'vitest'
import { DEFAULT_MANAGEMENT_ACTIONS, ManagementActionSchema } from '@foreman-code/contracts/management'
import { credentialActions } from '../src/cli/credentialAccess.js'
import { operatorToolAvailable } from '../src/mcp/operator/availability.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { parseCredentialArguments } from '../src/cli/operatorCredentialArguments.js'

describe('Browser credential CLI', () => {
  it('makes provider tools available to manage credentials and keeps read-only credentials narrow', () => {
    const context = (access: 'manage' | 'read-only'): OperatorRequestContext => ({
      principal: { id: 'operator', name: 'Operator', audience: 'operator', revokedAt: null,
        expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: credentialActions(access), scope: {} }] },
      services: { providerAccounts: {} },
    } as OperatorRequestContext)
    for (const name of ['provider_accounts_page', 'provider_account_create'] as const) {
      expect(operatorToolAvailable(context('manage'), name)).toBe(true)
      expect(operatorToolAvailable(context('read-only'), name)).toBe(false)
    }
  })
  it('read-only actions are an exact read-only subset of the shared catalog', () => {
    expect(credentialActions('read-only')).toEqual(DEFAULT_MANAGEMENT_ACTIONS.filter(action => action.endsWith(':read')
      && action !== 'devices:metrics:read' && action !== 'provider_accounts:read'))
    expect(credentialActions('read-only')).not.toContain('harnesses:update')
    expect(credentialActions('read-only')).not.toContain('interactions:respond')
    expect(credentialActions()).toEqual(DEFAULT_MANAGEMENT_ACTIONS)
    expect(credentialActions()).toEqual(ManagementActionSchema.options)
    expect(credentialActions()).toContain('ci')
    expect(credentialActions('read-only')).not.toContain('ci')
    expect(credentialActions('read-only')).not.toContain('provider_accounts:read')
    expect(credentialActions('read-only')).not.toContain('devices:metrics:read')
  })
  it('requires explicit operator audience for access presets', () => {
    expect(parseCredentialArguments(['issue', '--name', 'Browser', '--access', 'read-only'])).toMatchObject({ audience: 'operator', access: 'read-only' })
    expect(() => parseCredentialArguments(['issue', '--name', 'Worker', '--audience', 'worker', '--access', 'manage'])).toThrow()
    expect(() => parseCredentialArguments(['issue', '--name', 'User', '--audience', 'user', '--access', 'manage'])).toThrow()
  })
  it('issues manage credentials without a telemetry grant flag', () => {
    const input = parseCredentialArguments(['issue', '--name', 'Operator', '--access', 'manage'])
    expect(input).toMatchObject({ audience: 'operator', access: 'manage' })
    expect(credentialActions(input.command === 'issue' ? input.access : undefined))
      .toEqual(ManagementActionSchema.options)
    expect(parseCredentialArguments(['issue', '--name', 'Operator', '--grant', 'devices:metrics:read']))
      .toMatchObject({ audience: 'operator', grant: 'devices:metrics:read' })
  })
})
