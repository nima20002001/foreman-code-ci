/** Byte cursors inside a UTF-8 character skip to its end; a page never includes a partial character. */
export function ciLogPage(bytes: Buffer, afterOffset: number, maxBytes: number) {
  let start = Math.min(afterOffset, bytes.length)
  let end = Math.min(afterOffset + maxBytes, bytes.length)
  const continuation = (byte: number) => (byte & 0xc0) === 0x80
  while (start < end && continuation(bytes[start]!)) start++
  if (end > start) {
    let last = end - 1
    while (last > start && continuation(bytes[last]!)) last--
    const lead = bytes[last]!
    let length = 1
    if ((lead & 0xe0) === 0xc0) length = 2
    else if ((lead & 0xf0) === 0xe0) length = 3
    else if ((lead & 0xf8) === 0xf0) length = 4
    if (last + length > end) end = last
  }
  return { text: bytes.subarray(start, end).toString('utf8'), nextOffset: Math.max(afterOffset, end) }
}
