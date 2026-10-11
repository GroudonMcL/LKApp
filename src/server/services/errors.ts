/** A service-level error with an HTTP status and a human-readable message. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: string[] = [],
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
