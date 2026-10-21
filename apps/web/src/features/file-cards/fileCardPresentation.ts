import type { FileMediaType, FileWithRevision, MessageAttachmentRef } from '@foreman-code/contracts/files'

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

const typeLabels: Record<FileMediaType, string> = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
  'image/gif': 'GIF image',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'text/markdown': 'Markdown file',
  'application/zip': 'ZIP archive',
}

export function fileTypeLabel(mediaType: string): string {
  return typeLabels[mediaType as FileMediaType] ?? 'Binary file'
}

export function isRasterImage(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
}

export function formatFileSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`
  if (byteSize < 1024 * 1024) return `${Number((byteSize / 1024).toFixed(1))} KB`
  return `${Number((byteSize / (1024 * 1024)).toFixed(1))} MB`
}

/** IDs are a tuple, never joined with an ambiguous separator or replaced by currentRevisionId. */
export function fileCardKey(pin: MessageAttachmentRef): string {
  return JSON.stringify([pin.fileId, pin.revisionId])
}

/** Metadata hydration belongs to the enclosing server query. Missing pins stay unresolved. */
export function resolveMessageFileCards(
  attachments: readonly MessageAttachmentRef[],
  files: readonly FileWithRevision[],
): Array<FileWithRevision | undefined> {
  const byPin = new Map(files.map((file) => [fileCardKey(file.revision), file]))
  return attachments.map((pin) => byPin.get(fileCardKey(pin)))
}

/** Static signature checks are defense in depth, not a substitute for server byte validation. */
export function hasRasterSignature(bytes: Uint8Array, mediaType: string): boolean {
  const starts = (signature: readonly number[]) => signature.every((byte, index) => bytes[index] === byte)
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  switch (mediaType) {
    case 'image/png': return bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 4) === 'IHDR'
    case 'image/jpeg': return bytes.length >= 4 && starts([255, 216, 255])
    case 'image/gif': return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    case 'image/webp': return bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
    default: return false
  }
}
