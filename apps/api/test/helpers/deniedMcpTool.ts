import { expect } from 'vitest'

export async function expectMcpAccessDenied(call: Promise<unknown>): Promise<void> {
  expect(await call).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: expect.stringContaining('"ACCESS_DENIED"') }],
  })
}
