import { mkdtemp } from 'node:fs/promises'

/** Fixture roots share the invocation's private, protected ancestor. */
export function workspaceRootDirectory(): Promise<string> {
  return mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/w08-workspace-root-`)
}
