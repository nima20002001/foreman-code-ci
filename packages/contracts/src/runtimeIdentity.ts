import { z } from 'zod'

/** Frozen response for shipped strict browsers. Add runtime facts only on a versioned endpoint. */
export const RuntimeIdentitySchema = z.object({
  installationId: z.string().uuid(),
  checkoutId: z.string().regex(/^[a-f0-9]{64}$/),
  databaseId: z.string().regex(/^[a-f0-9]{64}$/),
  testResourcesId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>

/** Immutable browser/API build facts, served separately from installation ownership. */
export const RuntimeBuildIdentitySchema = z.object({
  version: z.literal(1),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  contractsId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type RuntimeBuildIdentity = z.infer<typeof RuntimeBuildIdentitySchema>

export function frozenRuntimeIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return RuntimeIdentitySchema.parse({ installationId: identity.installationId, checkoutId: identity.checkoutId,
    databaseId: identity.databaseId, ...(identity.testResourcesId !== undefined ? { testResourcesId: identity.testResourcesId } : {}) })
}

/** Browser requests belong to the installation verified before rendering the document. */
export const RUNTIME_INSTALLATION_HEADER = 'x-foreman-installation-id'
export const RuntimeInstallationHeaderSchema = RuntimeIdentitySchema.shape.installationId
