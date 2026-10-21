import { createHash } from 'node:crypto'
import { canonicalGraphJson, type RepeatGraphScopeV3, type RepeatGraphExecutionV3 } from '@foreman-code/contracts/wave25'

export function graphSourceDigest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
}
export function repeatExecutionStateDigest(scope: RepeatGraphScopeV3, execution: RepeatGraphExecutionV3): string {
  return graphSourceDigest({ scope, execution })
}
