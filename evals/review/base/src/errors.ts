export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A gateway failure worth retrying: the request may not have been processed.
export class TransientError extends Error {}

export function isTransient(err: unknown): boolean {
  return err instanceof TransientError;
}
