/** Presentation-only validation data. Domain validation stays in shared contracts. */
export interface FieldIssue { path: (string | number)[]; message: string }

export class FieldValidationError extends Error {
  constructor(readonly issues: FieldIssue[], options?: ErrorOptions) {
    super(issues.map((issue) => issue.message).join(' '), options)
    this.name = 'FieldValidationError'
  }
}

export function validationIssues(error: unknown): FieldIssue[] {
  if (!error || typeof error !== 'object') return []
  const candidate = 'issues' in error ? error.issues : undefined
  if (!Array.isArray(candidate)) return []
  return candidate.flatMap((issue: unknown) => {
    if (!issue || typeof issue !== 'object' || !('path' in issue) || !('message' in issue)
      || !Array.isArray(issue.path) || typeof issue.message !== 'string') return []
    return [{ path: issue.path.filter((part: unknown): part is string | number => typeof part === 'string' || typeof part === 'number'), message: issue.message }]
  })
}

export function withValidationPath<T>(prefix: (string | number)[], prepare: () => T): T {
  try { return prepare() } catch (error) {
    const issues = validationIssues(error)
    if (issues.length) throw new FieldValidationError(issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] })), { cause: error })
    throw error
  }
}

export function issuesAt(issues: readonly FieldIssue[], prefix: (string | number)[]): FieldIssue[] {
  return issues.filter((issue) => prefix.every((part, index) => issue.path[index] === part))
    .map((issue) => ({ ...issue, path: issue.path.slice(prefix.length) }))
}

export function fieldMessage(issues: readonly FieldIssue[], path: string): string | undefined {
  return [...new Set(issues.filter((issue) => {
    const key = issue.path.join('.')
    return key === path || key.startsWith(`${path}.`)
  }).map((issue) => issue.message))].join(' ') || undefined
}

export function focusFirstInvalid(root: HTMLElement | null): void {
  const field = root?.querySelector<HTMLElement>('[aria-invalid="true"]')
  if (!field) return
  let ancestor = field.parentElement
  while (ancestor && ancestor !== root) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement
  }
  field.focus()
}
