import type { CiHostRun } from '@foreman-code/contracts'
import { expect } from 'vitest'

export function expectCliRunMessage(run: CiHostRun, message: string | null) {
  expect(run.transport).toMatchObject({ source: 'cli',
    reason: expect.stringMatching(/^(GitHub Actions|CircleCI) REST credential resolution failed\.$/),
    lastError: expect.stringMatching(/^(GitHub Actions|CircleCI) REST credential resolution failed\.$/),
    fallbackCount: expect.any(Number) })
  const transport = run.transport!
  expect(transport.fallbackCount).toBeGreaterThan(0)
  expect(transport.lastError).toBe(transport.reason)
  const prefix = `CLI transport: ${transport.reason} (fallback count ${transport.fallbackCount}).`
  expect(run.message).toBe(message === null ? prefix : `${prefix} ${message}`)
}
