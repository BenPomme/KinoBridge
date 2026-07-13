export class KinoBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "KinoBridgeError";
  }
}

export function safeError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof KinoBridgeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL_ERROR", message: "The native helper could not complete the operation", retryable: false };
}
