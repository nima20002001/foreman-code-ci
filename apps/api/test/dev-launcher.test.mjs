import { describe, expect, it, vi } from 'vitest'

import { runningApiAcceptsBrowserOrigin } from '../../../scripts/dev.mjs'

describe('development launcher API reuse', () => {
  it('reuses passwordless access only when the running API trusts the expected browser Origin', async () => {
    const configuredOrigin = 'http://localhost:5175'
    const request = vi.fn(async (_url, options) => {
      const matches = options.headers.origin === configuredOrigin
      return {
        ok: matches,
        text: async () => matches ? '{"principal":{"id":"local-human"}}' : '{"error":{"code":"CSRF_ORIGIN_NOT_ALLOWED"}}',
      }
    })

    await expect(runningApiAcceptsBrowserOrigin('http://127.0.0.1:3000',
      'http://127.0.0.1:5173', request)).resolves.toBe(false)
    expect(request).toHaveBeenLastCalledWith('http://127.0.0.1:3000/api/local-human', expect.objectContaining({
      headers: { origin: 'http://127.0.0.1:5173' },
    }))
    await expect(runningApiAcceptsBrowserOrigin('http://127.0.0.1:3000',
      configuredOrigin, request)).resolves.toBe(true)
  })
})
