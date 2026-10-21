import { deepStrictEqual, strictEqual } from 'node:assert'

export interface ReplayTranscript {
  schemaVersion: 1
  provider: string
  protocolRevision: string
  redacted: true
  steps: readonly { operation: string; input: unknown; result?: unknown; error?: Error }[]
}

/** Protocol implementations call this below the real manager. Every outbound
 * call consumes one exact assertion; omitted calls cannot pass finish(). */
export class StrictProtocolReplay {
  private cursor = 0
  constructor(private readonly transcript: ReplayTranscript) {
    strictEqual(transcript.schemaVersion, 1, 'Unsupported replay transcript revision.')
    strictEqual(transcript.redacted, true, 'Replay transcripts must be redacted.')
  }
  async call(operation: string, input: unknown): Promise<unknown> {
    const step = this.transcript.steps[this.cursor]
    if (!step) throw new Error(`Unexpected outbound replay call: ${operation}`)
    strictEqual(operation, step.operation, `Replay operation ${this.cursor} differed.`)
    deepStrictEqual(input, step.input, `Replay input ${this.cursor} differed.`)
    this.cursor += 1
    if (step.error) throw step.error
    return structuredClone(step.result)
  }
  finish(): void {
    strictEqual(this.cursor, this.transcript.steps.length, 'Replay left expected outbound calls unused.')
  }
}

/** Tests explicitly release acknowledgments, frames and EOF; no race sleeps. */
export class ReplayGate<T = void> {
  readonly promise: Promise<T>
  private resolve!: (value: T) => void
  private reject!: (reason: unknown) => void
  private settled = false
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
  }
  release(value: T): void {
    if (this.settled) throw new Error('Replay gate was already settled.')
    this.settled = true
    this.resolve(value)
  }
  fail(reason: unknown): void {
    if (this.settled) throw new Error('Replay gate was already settled.')
    this.settled = true
    this.reject(reason)
  }
}
