import { describe, expect, it } from 'vitest'
import { createRemoteNativeSourceChannel } from './remoteNativeSource.js'

describe('remote original source capability boundary', () => {
  it('never treats a transport-shaped source descriptor as an issued capability', () => {
    const channel = createRemoteNativeSourceChannel()
    expect(() => channel.capture('execution', { type: 'boundary' })).toThrow('configured authenticated remote producer')
    expect(() => channel.verify.read({ provenance: 'remote', sourceDigest: 'a'.repeat(64) })).toThrow('configured authenticated remote producer')
  })
  it('does not infer original native evidence from another channel or JSON', () => {
    const first = createRemoteNativeSourceChannel(), second = createRemoteNativeSourceChannel()
    const descriptor = JSON.parse(JSON.stringify({ provenance: 'remote', sourceDigest: 'b'.repeat(64) }))
    expect(() => first.verify.read(descriptor)).toThrow('configured authenticated remote producer')
    expect(() => second.verify.read(descriptor)).toThrow('configured authenticated remote producer')
  })
})
