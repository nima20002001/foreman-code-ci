/** Copy an object's enumerable properties except the explicitly named fields. */
export function omitProperties<T extends object, K extends keyof T & string>(value: T, properties: readonly K[]): T extends unknown ? Omit<T, K> : never {
  const omitted = new Set<string>(properties)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key))) as T extends unknown ? Omit<T, K> : never
}
