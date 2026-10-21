export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error || error instanceof DOMException ? error.message : fallback
}
