import { DomainError } from '../errors.js'

/** Saved execution pins are mandatory and exact. Untagged create commands may
 * select V3 in the authoring service, but a missing saved pin is never legacy. */
export function runStartSemantics(input: { executionSemanticsVersion?: unknown }): 3 {
  if (input.executionSemanticsVersion !== 3) throw new DomainError(
    'EXECUTION_SEMANTICS_UNSUPPORTED', 'Only explicitly pinned execution semantics 3 may run.', 409)
  return 3
}
