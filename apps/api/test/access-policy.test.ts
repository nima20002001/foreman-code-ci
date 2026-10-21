import { describe, expect, it, vi } from 'vitest'

import { authorizationPrincipal, hasAction, isAuthorized } from '../src/modules/access/policy.js'

const principal = {
  id: 'principal-1', name: 'Worker named Operator', audience: 'operator' as const,
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workflows:read' as const], scope: { workspaceIds: ['workspace-1'] } }],
}

describe('management access policy', () => {
  it('is deny-by-default and scopes resources', () => {
    expect(isAuthorized(principal, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(true)
    expect(isAuthorized(principal, 'workflows:read', { workspaceId: 'workspace-2' })).toBe(false)
    expect(isAuthorized(principal, 'workflows:update', { workspaceId: 'workspace-1' })).toBe(false)
  })

  it('does not derive authority from a display name or worker audience', () => {
    expect(isAuthorized({ ...principal, audience: 'worker' }, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
    expect(isAuthorized({ ...principal, revokedAt: '2026-09-15T00:00:00.000Z' }, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
  })

  it('reuses an immutable validation snapshot without retaining mutable caller grants', () => {
    const caller = structuredClone(principal)
    const snapshot = authorizationPrincipal(caller)
    expect(authorizationPrincipal(snapshot)).toBe(snapshot)
    expect(hasAction(snapshot, 'workflows:read')).toBe(true)
    expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-2' })).toBe(false)
    expect(() => snapshot.grants[0]!.scope.workspaceIds!.push('workspace-2')).toThrow(TypeError)
    expect(() => snapshot.grants[0]!.actions.push('workflows:update')).toThrow(TypeError)
    expect(() => { snapshot.revokedAt = '2098-01-01T00:00:00.000Z' }).toThrow(TypeError)
    caller.grants[0]!.scope.workspaceIds = ['workspace-2']
    expect(isAuthorized(caller, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
    expect(isAuthorized(caller, 'workflows:read', { workspaceId: 'workspace-2' })).toBe(true)
    caller.grants = []
    expect(hasAction(caller, 'workflows:read')).toBe(false)
    expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(true)
  })

  it('checks expiry on every authorization even after snapshot validation', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2098-12-31T23:59:59.000Z'))
      const snapshot = authorizationPrincipal(principal)
      expect(hasAction(snapshot, 'workflows:read')).toBe(true)
      expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(true)
      vi.setSystemTime(new Date(snapshot.expiresAt))
      expect(hasAction(snapshot, 'workflows:read')).toBe(false)
      expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks large workflow scopes without combining read and update grants', () => {
    const workflowIds = Array.from({ length: 5_000 }, (_, index) => `workflow-${index}`)
    const grants = Array.from({ length: 10 }, (_, index) => {
      const ids = workflowIds.slice(index * 500, (index + 1) * 500)
      return [
        { actions: ['workflows:read' as const], scope: { workspaceIds: ['workspace-1'], workflowIds: ids } },
        { actions: ['workflows:update' as const], scope: { workspaceIds: ['workspace-2'], workflowIds: ids } },
      ]
    }).flat()
    const caller = { ...principal, grants }
    const snapshot = authorizationPrincipal(caller)
    for (const workflowId of workflowIds) {
      expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-1', workflowId })).toBe(true)
      expect(isAuthorized(snapshot, 'workflows:update', { workspaceId: 'workspace-1', workflowId })).toBe(false)
      expect(isAuthorized(snapshot, 'workflows:update', { workspaceId: 'workspace-2', workflowId })).toBe(true)
    }
    expect(isAuthorized(snapshot, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
    expect(isAuthorized(snapshot, 'workflows:read', {
      workspaceId: 'workspace-1', workflowId: 'workflow-missing',
    })).toBe(false)
    caller.grants[0]!.scope.workflowIds = []
    expect(isAuthorized(caller, 'workflows:read', {
      workspaceId: 'workspace-1', workflowId: workflowIds[0]!,
    })).toBe(false)
    expect(isAuthorized(snapshot, 'workflows:read', {
      workspaceId: 'workspace-1', workflowId: workflowIds[0]!,
    })).toBe(true)
  })

  it('still rejects malformed mutable principals after a valid authorization', () => {
    const caller = structuredClone(principal)
    expect(hasAction(caller, 'workflows:read')).toBe(true)
    Object.assign(caller, { expiresAt: 'invalid' })
    expect(() => hasAction(caller, 'workflows:read')).toThrow()
    expect(() => isAuthorized(caller, 'workflows:read')).toThrow()
  })
})
