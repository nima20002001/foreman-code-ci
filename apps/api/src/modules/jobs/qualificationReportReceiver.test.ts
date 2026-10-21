import { describe, expect, it, vi } from 'vitest'
import { qualificationReportFixture } from '../../../test/helpers/qualificationReportFixture.js'

describe('authenticated diagnostic packet sealing with serialized metadata fixtures', () => {
  it('seals large reports through bounded packets and accepts an identical acknowledged retry', async () => {
    const f = qualificationReportFixture()
    const authorize = vi.fn(async () => {})
    const chunk = f.bytes.subarray(0, 1048576)
    expect(await f.receive(f.candidate, f.report, 0, chunk, authorize)).toEqual({ receivedBytes: chunk.length, artifact: null })
    expect(await f.receive(f.candidate, f.report, 0, chunk, authorize)).toEqual({ receivedBytes: chunk.length, artifact: null })
    expect(f.publish).not.toHaveBeenCalled()
    expect(await f.receive(f.candidate, f.report, chunk.length, f.bytes.subarray(chunk.length), authorize))
      .toEqual({ receivedBytes: f.bytes.length, artifact: f.artifact })
    expect(f.publish).toHaveBeenCalledOnce()
  })

  it('denies unauthorized, changed and noncontiguous packets before publication', async () => {
    const f = qualificationReportFixture()
    const chunk = f.bytes.subarray(0, 1048576)
    await expect(f.receive(f.candidate, f.report, 0, chunk, async () => { throw new Error('denied caller') }))
      .rejects.toThrow('denied caller')
    const authorize = async () => {}
    await expect(f.receive(f.candidate, f.report, 1, chunk, authorize)).rejects.toThrow('packet admission')
    await f.receive(f.candidate, f.report, 0, chunk, authorize)
    await expect(f.receive(f.candidate, f.report, 0, Buffer.alloc(chunk.length), authorize)).rejects.toThrow('packet changed')
    await expect(f.receive(f.candidate, { ...f.report, sha256: 'b'.repeat(64) }, chunk.length,
      f.bytes.subarray(chunk.length), authorize)).rejects.toThrow('metadata changed')
    expect(f.publish).not.toHaveBeenCalled()
  })
})
