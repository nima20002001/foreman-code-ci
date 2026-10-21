import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PRODUCT_SLUG } from '@foreman-code/contracts/product'

const ProductManifestSchema = z.object({
  name: z.literal(PRODUCT_SLUG),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
})

export function readProductVersion(releaseDirectory: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(releaseDirectory, 'package.json'), 'utf8'))
  return ProductManifestSchema.parse(manifest).version
}
