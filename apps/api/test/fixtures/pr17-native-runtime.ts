export async function bounded<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The event iterator slept despite an unread event.')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
