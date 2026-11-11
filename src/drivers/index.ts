import { z } from 'zod';
import { DriverError } from '../contracts/driver.js';
import { DriverRegistry } from '../contracts/registry.js';
import { HerdrRuntime } from './runtime/herdr/herdr-runtime.js';

const herdrOptions = z.strictObject({
  binary: z.string().min(1).optional(),
  minimumVersion: z.string().optional(),
});

/** A registry with every built-in driver. Milestone 0 ships the Herdr runtime only. */
export function createDriverRegistry(): DriverRegistry {
  return new DriverRegistry().register('runtime', 'herdr', (options) => {
    const parsed = herdrOptions.safeParse(options);
    if (!parsed.success) {
      throw new DriverError(
        'herdr',
        'invalid',
        `Invalid herdr options: ${z.prettifyError(parsed.error)}`,
      );
    }
    return new HerdrRuntime({
      ...(parsed.data.binary !== undefined && { binary: parsed.data.binary }),
      ...(parsed.data.minimumVersion !== undefined && {
        minimumVersion: parsed.data.minimumVersion,
      }),
    });
  });
}
