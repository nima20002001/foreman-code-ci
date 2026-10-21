export function integrationPhaseLine(file: string, phase: string, elapsedMs: number): string
export function integrationPhaseForwarder(write: (line: string) => void): {
  push(chunk: string | Buffer): void
  finish(): void
}
