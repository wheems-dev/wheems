/**
 * Every extension point in Opinr is a driver: a small, documented contract with
 * built-in drivers behind it. Version one has runtime, engine and channel
 * contracts; integration, account, trigger, step, isolation and secret-store
 * contracts follow in later milestones.
 */
export type DriverKind = 'runtime' | 'engine' | 'channel';

export interface Driver<K extends DriverKind = DriverKind> {
  readonly kind: K;
  /** The name config uses to pick this driver, such as `herdr` or `claude-code`. */
  readonly name: string;
}

/** The result of one health check, shown by `opinr doctor`. */
export interface HealthCheck {
  /** Short name of what was checked, such as `hc version`. */
  name: string;
  /** `skip` means the check did not apply. Only `fail` makes doctor fail. */
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  /** What to do about a warning or failure. */
  hint?: string;
}

export type DriverErrorKind =
  /** The thing addressed does not exist. */
  | 'not_found'
  /** The driver does not support this operation or option. */
  | 'unsupported'
  /** The service or program behind the driver cannot be reached or is missing. */
  | 'unavailable'
  /** The program behind the driver is older than the pinned minimum. */
  | 'version'
  /** A person is needed first, such as a permission prompt. */
  | 'blocked'
  /** The request was malformed. */
  | 'invalid'
  /** Anything else. */
  | 'failed';

/** The one error type drivers throw, so callers can react to `kind` whatever the driver. */
export class DriverError extends Error {
  readonly kind: DriverErrorKind;
  readonly driver: string;
  readonly hint: string | undefined;

  constructor(
    driver: string,
    kind: DriverErrorKind,
    message: string,
    options?: { hint?: string | undefined; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DriverError';
    this.driver = driver;
    this.kind = kind;
    this.hint = options?.hint;
  }
}

export function isDriverError(error: unknown, kind?: DriverErrorKind): error is DriverError {
  return error instanceof DriverError && (kind === undefined || error.kind === kind);
}
