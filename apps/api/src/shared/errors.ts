/** One error shape, one code list. The client can switch on `code` safely. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'VALIDATION_FAILED', message, details);

export const unauthenticated = (code = 'UNAUTHENTICATED', message = 'Authentication required.') =>
  new ApiError(401, code, message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new ApiError(403, 'FORBIDDEN', message);

export const storeAccessDenied = () =>
  new ApiError(403, 'STORE_ACCESS_DENIED', 'You have no grant for this store.');

export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);

export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);

export const rateLimited = (message = 'Too many requests.') =>
  new ApiError(429, 'RATE_LIMITED', message);
