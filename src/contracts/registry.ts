import type { ChannelDriver } from './channel.js';
import { DriverError, type DriverKind } from './driver.js';
import type { EngineDriver } from './engine.js';
import type { RuntimeDriver } from './runtime.js';

export interface DriverTypes {
  runtime: RuntimeDriver;
  engine: EngineDriver;
  channel: ChannelDriver;
}

/** Builds a driver from its config section. Each driver validates its own options. */
export type DriverFactory<K extends DriverKind> = (
  options: Record<string, unknown>,
) => DriverTypes[K];

/**
 * Where drivers are registered by kind and name, as Laravel's managers do.
 * Built-in drivers register here; plugins will register through it too.
 */
export class DriverRegistry {
  private readonly factories = new Map<string, DriverFactory<DriverKind>>();

  register<K extends DriverKind>(kind: K, name: string, factory: DriverFactory<K>): this {
    const key = `${kind}:${name}`;
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
