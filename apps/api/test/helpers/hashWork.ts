import type { Hash } from 'node:crypto'
import { vi } from 'vitest'

const hashWork = vi.hoisted(() => ({ bytes: 0, limit: Infinity }))
export { hashWork }

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const instrument = (hash: Hash): Hash => {
    const update = hash.update.bind(hash)
    const copy = hash.copy.bind(hash)
    hash.update = (data, encoding) => {
      hashWork.bytes += typeof data === 'string' ? Buffer.byteLength(data, encoding) : data.byteLength
      if (hashWork.bytes > hashWork.limit) throw new Error('Hash work exceeded the linear delivery budget')
      return update(data, encoding)
    }
    hash.copy = options => instrument(copy(options))
    return hash
  }
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => instrument(actual.createHash(...args)) }
})
