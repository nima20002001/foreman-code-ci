import { RuntimeBuildIdentitySchema, type RuntimeBuildIdentity } from '@foreman-code/contracts'

declare const __RUNTIME_BUILD_IDENTITY__: RuntimeBuildIdentity | null

/** Vite replaces this with the identity captured when this document's bundle was built. */
export const documentBuildIdentity = RuntimeBuildIdentitySchema.parse(__RUNTIME_BUILD_IDENTITY__
  ?? JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="foreman-runtime-build"]')?.content ?? 'null'))
