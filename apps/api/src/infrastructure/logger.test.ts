import { expect, it } from 'vitest'
import { logger, serializeError } from './logger.js'

it('serializes original error identity and bounded cyclic causes without child process handles', () => {
  const child: { child?: unknown } = {}; child.child = child
  const cause = Object.assign(new Error('Original capture deadline.'), { code: 'ABORT_ERR', child })
  const error = Object.assign(new Error('Source capture failed.', { cause }), { code: 'SOURCE_CAPTURE_FAILED', child })
  Object.assign(cause, { cause: error })
  const serialized = serializeError(error)
  expect(() => JSON.stringify(serialized)).not.toThrow()
  expect(serialized).toMatchObject({ type: 'Error', message: 'Source capture failed.', code: 'SOURCE_CAPTURE_FAILED',
    cause: { message: 'Original capture deadline.', code: 'ABORT_ERR', cause: { message: 'Repeated or truncated error cause.' } } })
  expect(serialized).not.toHaveProperty('child')
  const serializers = Reflect.get(logger, Symbol.for('pino.serializers')) as { err(value: unknown): unknown; error(value: unknown): unknown }
  expect(serializers.err(error)).toEqual(serialized); expect(serializers.error(error)).toEqual(serialized)
})

it('includes bounded aggregate failures so shutdown reports the failing step', () => {
  const failure = new Error('Runtime shutdown step byte ownership failed.', {
    cause: new AggregateError([new Error('Original rsync channel unavailable')], 'Writers did not stop'),
  })
  const error = new AggregateError([failure], 'Runtime shutdown incomplete')
  error.errors.push(error)
  expect(serializeError(error)).toMatchObject({
    message: 'Runtime shutdown incomplete',
    errors: [
      { message: 'Runtime shutdown step byte ownership failed.', cause: {
        errors: [{ message: 'Original rsync channel unavailable' }],
      } },
      { message: 'Repeated or truncated error cause.' },
    ],
  })
  expect(serializeError(new AggregateError(Array.from({ length: 20 }, () => new Error('failure'))))).toHaveProperty('errors.length', 8)
})
