import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { redactKnownSecrets, redactSecretText } from '../src/modules/harnesses/secrets.js'

describe('ENG-03 concurrent native event redaction', () => {
  it('preserves nested, key, and JSON-escaped secret redaction without changing the input', () => {
    const secret = 'sk-test-' + 'A'.repeat(72)
    const source = { [secret]: [{ text: secret, nested: { encoded: JSON.stringify([secret]) } }], safe: null }
    const before = structuredClone(source)
    const redacted = redactKnownSecrets(source, [secret, '', secret])
    expect(redacted).toEqual({ '[REDACTED]': [{ text: '[REDACTED]', nested: { encoded: '["[REDACTED]"]' } }], safe: null })
    expect(source).toEqual(before)
    expect(redactSecretText(JSON.stringify({ value: secret }), [secret])).toBe('{"value":"[REDACTED]"}')
    expect(redactSecretText(String.raw`{"token":"\u0073ecret"}`, ['secret']))
      .toBe('{"token":"[REDACTED]"}')
    expect(redactSecretText(String.raw`{"\u0073ecret":"safe"}`, ['secret']))
      .toBe('{"[REDACTED]":"safe"}')
  })

  it('keeps a large nested native payload below the event-loop blocking budget', async () => {
    const secret = 'sk-test-' + 'A'.repeat(72)
    const password = 'opaque-password-' + 'B'.repeat(48)
    const payload = { messages: Array.from({ length: 10_000 }, (_, index) => ({
      info: { id: `message-${index}`, role: 'assistant', time: { created: index, completed: index + 1 } },
      parts: [
        { type: 'text', text: `n=${index} value=${index * index} ${index % 97 === 0 ? secret : 'ordinary text'}` },
        { type: 'step-start', snapshot: JSON.stringify({ secret: index % 113 === 0 ? password : 'safe' }) },
      ],
    })) }
    const started = performance.now()
    const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 0))
    const result = redactKnownSecrets(payload, [secret, password, '', secret])
    const eventLoopDelayMs = await timer
    expect(result.messages).toHaveLength(10_000)
    expect(result.messages[0]?.parts[0]?.text).toContain('[REDACTED]')
    expect(result.messages[0]?.parts[1]?.snapshot).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(password)
    expect(eventLoopDelayMs).toBeLessThan(750)
  })

})
