export function parseCiLock(text: string): {
  packages?: Record<string, { resolution: { integrity: string } }>
}
export function buildCiRuntimeContext(input: {
  repository: string
  commit?: string
  output: string
  offlineSeed?: {
    directory: string
    receiptPath: string
    unitCodex?: {
      path: string
      binarySha256: string
      version: string
      review: { reviewedByPrincipalId: string; decisionDigest: string; reviewedAt: string }
    }
  }
}): Promise<unknown>
export function ciRuntimeInputDigest(input: { repository: string; commit: string }): Promise<string>
