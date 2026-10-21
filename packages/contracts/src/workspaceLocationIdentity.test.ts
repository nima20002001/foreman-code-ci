import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkspaceLocationIdentitySchema } from './workspaceRootPolicies.js'

it('preserves complete registered location identity alongside plain local folders', () => {
  const mainId = randomUUID()
  const registered = { device: '1', inode: '2', mountId: '3', hostRef: { kind: 'main', mainId },
    applicationInstallationId: mainId, directoryIdentityHash: 'a'.repeat(64) }
  expect(WorkspaceLocationIdentitySchema.parse(registered)).toEqual(registered)
  expect(WorkspaceLocationIdentitySchema.parse({ device: '1', inode: '2' })).toEqual({ device: '1', inode: '2' })
  expect(WorkspaceLocationIdentitySchema.safeParse({ ...registered, applicationInstallationId: randomUUID() }).success).toBe(false)
  expect(WorkspaceLocationIdentitySchema.safeParse({ device: '1', inode: '2', mountId: '3' }).success).toBe(false)
  expect(WorkspaceLocationIdentitySchema.safeParse({ ...registered, unrelatedAuthority: true }).success).toBe(false)
})
