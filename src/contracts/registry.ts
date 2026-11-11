import type { ChannelDriver } from './channel.js';
import { DriverError, type DriverKind } from './driver.js';
import type { EngineDriver } from './engine.js';
import type { RuntimeDriver } from './runtime.js';
import type { ConnectFlow, EngineSetup } from './setup.js';

export interface DriverTypes {
  runtime: RuntimeDriver;
  engine: EngineDriver;
  channel: ChannelDriver;
}

/** Builds a driver from its config section. Each driver validates its own options. */
export type DriverFactory<K extends DriverKind> = (
  options: Record<string, unknown>,
) => DriverTypes[K];

/** How a driver appears in `opinr setup`. */
export interface DriverInfo {
  /** Its name for people, such as `Slack`. */
  label: string;
  description: string;
  /** Its interactive connect flow, for drivers that need credentials. */
  connect?: ConnectFlow;
  /** For engines: how to install it, sign in and wire it to Herdr. */
  engine?: EngineSetup;
}

/** A driver as `opinr setup` lists it: one that works, or one that is coming later. */
export interface CatalogEntry extends DriverInfo {
  name: string;
  available: boolean;
}

/**
 * Where drivers are registered by kind and name, as Laravel's managers do.
 * Built-in drivers register here; plugins will register through it too.
 */
export class DriverRegistry {
  private readonly factories = new Map<string, DriverFactory<DriverKind>>();
  private readonly info = new Map<string, DriverInfo>();
  private readonly planned = new Map<string, DriverInfo>();

  register<K extends DriverKind>(
    kind: K,
    name: string,
    factory: DriverFactory<K>,
    info?: DriverInfo,
  ): this {
    const key = `${kind}:${name}`;
    if (info) this.info.set(key, info);
    if (this.factories.has(key)) {
      throw new DriverError(
        name,
        'invalid',
        `A ${kind} driver named "${name}" is already registered`,
      );
    }
    this.factories.set(key, factory);
    return this;
  }

  /** Lists a driver that is coming later, so setup can show it as such. */
  plan(kind: DriverKind, name: string, info: DriverInfo): this {
    this.planned.set(`${kind}:${name}`, info);
    return this;
  }

  /** Every driver of a kind that has setup information, available ones first. */
  catalog(kind: DriverKind): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const name of this.names(kind)) {
      const info = this.info.get(`${kind}:${name}`);
      if (info) entries.push({ name, available: true, ...info });
    }
    const prefix = `${kind}:`;
    for (const [key, info] of this.planned) {
      const name = key.slice(prefix.length);
      if (key.startsWith(prefix) && !this.has(kind, name))
        entries.push({ name, available: false, ...info });
    }
    return entries;
  }

  has(kind: DriverKind, name: string): boolean {
    return this.factories.has(`${kind}:${name}`);
  }

  names(kind: DriverKind): string[] {
    const prefix = `${kind}:`;
    return [...this.factories.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  create<K extends DriverKind>(
    kind: K,
    name: string,
    options: Record<string, unknown> = {},
  ): DriverTypes[K] {
    const factory = this.factories.get(`${kind}:${name}`) as DriverFactory<K> | undefined;
    if (!factory) {
      const known = this.names(kind);
      throw new DriverError(name, 'not_found', `No ${kind} driver named "${name}"`, {
        hint: known.length > 0 ? `Known ${kind} drivers: ${known.join(', ')}` : undefined,
      });
    }
    return factory(options);
  }
}
