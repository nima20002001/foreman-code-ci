import { ApiError } from './client'

export function isApiAccessError(error: unknown): error is ApiError {
  return ApiError.is(error) && (error.status === 401 || error.status === 403)
}
