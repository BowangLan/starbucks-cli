export class StarbucksError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StarbucksError";
  }
}
export class OrderSubmissionDisabledError extends StarbucksError {
  constructor() {
    super(
      "Order submission is disabled in this transport. No order was placed.",
    );
    this.name = "OrderSubmissionDisabledError";
  }
}
export class NotSignedInError extends StarbucksError {
  constructor() {
    super(
      "Not signed in. Use login or auth import --file <file>.",
      undefined,
      "NOT_SIGNED_IN",
    );
    this.name = "NotSignedInError";
  }
}
/** A failed sign-in. The message has credentials and URLs removed. */
export class LoginError extends StarbucksError {
  constructor(
    message: string,
    readonly traceFile?: string,
  ) {
    super(message, undefined, "LOGIN_FAILED");
    this.name = "LoginError";
  }
}
