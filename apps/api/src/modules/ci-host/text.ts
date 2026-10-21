/** PostgreSQL text and jsonb reject NUL and unpaired Unicode surrogates. */
export function sanitizeCiText(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8').replaceAll('\0', '')
}

export function serializeCiJson(value: object): string {
  return JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'string' ? sanitizeCiText(entry) : entry)
}
