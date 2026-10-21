/** Credit-specific provider diagnostics; a skipped job or a generic billing error is insufficient. */
export function isCircleCreditRefusal(error: { type: string; message: string }): boolean {
  if (error.type === 'config') return false
  return error.type === 'plan-no-credits-available'
    || /\b(?:no credits (?:are )?available|insufficient credits|credits (?:have been |are )?exhausted)\b/i.test(error.message)
}
