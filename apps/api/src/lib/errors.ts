/** App-level error with a stable code; logged by the API with full stack. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}