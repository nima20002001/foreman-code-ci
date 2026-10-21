import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TrustedConnectionConfigureSchema } from './trustedDeviceConnection.js'

describe('trusted device connection configuration', () => {
  it('accepts a revisioned connection change without an approval receipt', () => {
    const input = {
      deviceId: randomUUID(), commandId: randomUUID(), expectedRevision: 0,
      expectedAuthorizationRevision: 1,
      endpoint: { transport: 'lan', host: '192.0.2.10', port: 22, osUser: 'test-user' },
      hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true,
    }
    expect(TrustedConnectionConfigureSchema.parse(input)).toEqual(input)
    expect(TrustedConnectionConfigureSchema.safeParse({ ...input, approvalId: randomUUID() }).success).toBe(false)
  })
})
