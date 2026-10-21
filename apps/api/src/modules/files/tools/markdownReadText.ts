import type { AgentFileReadResult } from '@foreman-code/contracts/files'

export function markdownReadText(result: AgentFileReadResult): string | undefined {
  if (result.status !== 'ready' || result.revision.mediaType !== 'text/markdown') return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.from(result.contentBase64, 'base64'))
  } catch (error) {
    // A byte range can split a UTF-8 character; its original bytes remain available.
    if (error instanceof TypeError) return undefined
    throw error
  }
}
