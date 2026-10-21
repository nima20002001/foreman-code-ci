import { AutoJobDefinitionSpecSchema } from '@foreman-code/contracts/jobs'
import { AutoVerificationJobSpecSchema, isAutoJobSpecRecord, jobPolicyRequirementsRecord,
  type JobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import type { JobPlacementIntent } from '@foreman-code/contracts/job-admission'
import type { JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'

export function jobPlacementRequest(spec: JobDefinitionSpecRecord, options: {
  placementOverride?: JobPlacementIntent | null | undefined
  limits?: JobRuntimeProfile['limits'] | undefined
}): JobDefinitionSpecRecord {
  if (!options.placementOverride) return spec
  const schema = 'verification' in spec ? AutoVerificationJobSpecSchema : AutoJobDefinitionSpecSchema
  return schema.parse({ ...spec, target: { kind: 'auto' },
    policy: isAutoJobSpecRecord(spec) ? spec.policy : jobPolicyRequirementsRecord(spec.policy),
    limits: options.limits })
}
