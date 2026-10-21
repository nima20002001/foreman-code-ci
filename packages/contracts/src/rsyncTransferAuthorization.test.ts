import { expect, it } from 'vitest'
import { RsyncTransferAuthorizeRequestSchema, RsyncControlRequestSchema } from './byteTransfer.js'
const request = { kind: 'rsync-stage-v1', method: 'transfer-authorize', transferId: '11111111-1111-4111-8111-111111111111' }
it('uses an ID-only original-membership lookup outside the writer/control union', () => {
  expect(RsyncTransferAuthorizeRequestSchema.parse(request)).toEqual(request)
  expect(RsyncControlRequestSchema.safeParse(request).success).toBe(false)
  expect(RsyncControlRequestSchema.parse({ ...request, method: 'writer-prepare' }).method).toBe('writer-prepare')
})
it('rejects caller intent, paths, identity overrides and malformed transfer IDs', () => {
  for (const value of [
    { ...request, intent: {} }, { ...request, path: '/caller-selected' }, { ...request, workspaceId: 'other' },
    { ...request, connectionEpoch: '11111111-1111-4111-8111-111111111111' },
    { ...request, transferId: 'invalid' }, { ...request, method: 'writer-prepare' }, { ...request, kind: 'rsync-stage-v2' },
  ]) expect(RsyncTransferAuthorizeRequestSchema.safeParse(value).success).toBe(false)
})
