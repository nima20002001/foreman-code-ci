type DefinedProperties<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

/** Match JSON's missing-property semantics at validated transport boundaries. */
export function definedProperties<T extends object>(value: T): DefinedProperties<T> {
  return Object.fromEntries(Object.entries(value).filter(([, property]) => property !== undefined)) as DefinedProperties<T>
}
