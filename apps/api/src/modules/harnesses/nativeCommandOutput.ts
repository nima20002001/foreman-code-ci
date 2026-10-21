import type { Readable } from 'node:stream'

/** One byte budget shared by stdout and stderr. Check each chunk before retaining it. */
export function nativeOutputCollector(limit: number, redact: (text: string) => string = (text) => text) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32_000_000) throw new Error('Invalid native command output limit.')
  let collected = 0
  return async (stream: Readable): Promise<string> => {
    stream.setEncoding('utf8')
    let text = ''
    for await (const chunk of stream) {
      const value = String(chunk)
      collected += Buffer.byteLength(value)
      if (collected > limit) throw new Error('Native command output exceeded its bounded collection limit.')
      text += value
    }
    return redact(text)
  }
}
