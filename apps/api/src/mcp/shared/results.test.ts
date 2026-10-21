import { expect, it } from 'vitest'
import { DomainError } from '../../modules/errors.js'
import { FileTransferError } from '../../modules/files/tools/transfers.js'
import { SourceError } from '../../modules/sources/manifest.js'
import { toolFailure } from './results.js'

it.each([
  ['SOURCE_PATH_INVALID', 'Source paths must be unambiguous relative paths.', 400],
  ['SOURCE_SENSITIVE_PATH', 'Source paths cannot name credential or sensitive files.', 400],
  ['SOURCE_CAPACITY', 'Source capacity exceeded.', 413],
  ['SOURCE_CAPTURE_TIMEOUT', 'Source capture timed out.', 503],
] as const)('preserves the public source error %s and its HTTP status', (code, message, status) => {
  const cause = new Error('private filesystem details')
  const error = new SourceError(code, message, { cause })
  expect(error).toBeInstanceOf(DomainError)
  expect(error.status).toBe(status)
  expect(error.cause).toBe(cause)
  expect(toolFailure(error)).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  })
})

it('preserves typed file transfer failures', () => {
  const code = 'FILE_WRITE_INTERRUPTED'
  const message = 'The artifact write did not complete.'
  expect(toolFailure(new FileTransferError(code, message))).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  })
})

it('keeps unrecognized errors and private causes out of public tool responses', () => {
  const error = Object.assign(new Error('private path and credentials'), { code: 'PRIVATE_ERROR', status: 400 })
  expect(toolFailure(error)).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: {
      code: 'INTERNAL_ERROR', message: 'The Operator service could not complete the request.',
    } }) }],
  })
})
