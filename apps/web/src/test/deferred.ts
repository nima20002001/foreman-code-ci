export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

export interface RejectableDeferred<T> extends Deferred<T> {
  reject: (reason?: unknown) => void
}

export function deferred<T = void>(): Deferred<T> {
  const { promise, resolve } = rejectableDeferred<T>()
  return { promise, resolve }
}

export function rejectableDeferred<T = void>(): RejectableDeferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: RejectableDeferred<T>['reject']
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}
