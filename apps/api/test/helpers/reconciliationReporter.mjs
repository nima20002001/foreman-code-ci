export function reconciliationReporter({ pending, failure }) {
  return error => {
    if (error instanceof Error && error.code === 'SOURCE_EXECUTION_UNCERTAIN') {
      pending(error)
      return
    }
    failure(error)
  }
}
