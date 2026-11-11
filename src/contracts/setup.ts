/**
 * Setting things up interactively. A driver that needs credentials or choices brings its
 * own connect flow; `opinr setup` shows it through a SetupUi, so a new driver (Telegram,
 * Discord, a plugin's) needs no changes to the setup command.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** Shown but not selectable, such as a driver that is coming later. */
  disabled?: boolean;
}

/** What a connect flow can do on screen. Every question can be cancelled (SetupCancelled). */
export interface SetupUi {
  /** A boxed note, such as step-by-step instructions. */
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  text(options: {
    message: string;
    placeholder?: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  /** Asks for a credential. What is typed is masked. */
  secret(options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  select<T extends string>(options: {
    message: string;
    choices: Choice<T>[];
    initial?: T;
  }): Promise<T>;
  /** Runs work with a spinner, ending with what the result says. */
  task<T>(message: string, run: () => Promise<T>, done: (result: T) => string): Promise<T>;
}

/** Thrown when the person cancels a question (Ctrl+C or Esc). */
export class SetupCancelled extends Error {
  constructor() {
    super('Setup cancelled');
    this.name = 'SetupCancelled';
  }
}

export interface ConnectContext {
  /** The credentials saved for this connection before, if any. */
  existing: Record<string, string> | undefined;
  /** Who may already talk to agents through this connection. */
  allowedUsers: string[];
  /** A private folder for files the flow writes, such as an app manifest. */
  stateDir: string;
  /** Puts text on the clipboard. Resolves false where there is no clipboard. */
  copy(text: string): Promise<boolean>;
  /** Opens a web page in the person's browser. Resolves false where it can't. */
  openUrl(url: string): Promise<boolean>;
}

export interface ConnectResult {
  /** Credentials to save to the private secrets file. Never written to config. */
  secret: Record<string, string>;
  /** Who may talk to agents through this connection (chat connections). */
  allowedUsers: string[];
}

/** A driver's interactive connect flow, run by `opinr setup`. */
export interface ConnectFlow {
  connect(ui: SetupUi, context: ConnectContext): Promise<ConnectResult>;
}
