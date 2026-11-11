import { isAbsolute, normalize } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentDefinition, EngineContext, EngineDriver } from '../contracts/engine.js';
import { expectHealthCheck } from './runtime-contract.js';

export interface EngineContractOptions {
  create: () => EngineDriver | Promise<EngineDriver>;
  /** A model id this engine accepts. */
  model: string;
  /** The account driver this engine is paid through, such as `claude`. */
  accountDriver: string;
  /**
   * Whether health checks must pass. Engines whose CLI is not installed where the
   * suite runs (such as CI) can set this to false; checks must still be well formed.
   */
  expectHealthy?: boolean;
}

/**
 * The engine contract test suite. Every engine driver must pass it.
 *
 *   engineContract('my-engine', { create: () => new MyEngine(), model: 'x', accountDriver: 'y' });
 */
export function engineContract(label: string, options: EngineContractOptions): void {
  describe(`engine contract: ${label}`, () => {
    let driver: EngineDriver;
    const root = isWindows() ? 'C:\\opinr-contract' : '/opinr-contract';
    const agent: AgentDefinition = {
      name: 'contract-agent',
      description: 'An agent used by the engine contract tests',
      engine: '',
      model: options.model,
      account: 'contract-account',
      skills: [],
      integrations: [],
      instructions: '# Contract agent\n\nReply with the word ready.',
    };
    const context: EngineContext = {
      workspace: { id: 'contract', dir: `${root}/workspaces/contract` },
      sessionDir: `${root}/workspaces/contract/sessions/contract-agent`,
      account: { name: 'contract-account', driver: options.accountDriver },
    };

    beforeAll(async () => {
      driver = await options.create();
      agent.engine = driver.name;
    });

    it('identifies itself as an engine driver', () => {
      expect(driver.kind).toBe('engine');
      expect(driver.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });

    it('declares its capabilities', () => {
      const caps = driver.capabilities;
      expect(caps.instructionsFile).toMatch(/^[^/\\]+$/);
      for (const key of ['skills', 'mcp', 'hooks', 'permissions'] as const) {
        expect(typeof caps[key]).toBe('boolean');
      }
    });

    it('reports well-formed health checks', async () => {
      const checks = await driver.check();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expectHealthCheck(check);
      if (options.expectHealthy ?? true) {
        expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
      }
    });

    it('plans a launch without touching the disk', async () => {
      // The context points at folders that do not exist; a driver that reads or writes them fails here.
      const plan = await driver.prepare(agent, context);
      expect(plan.command.length).toBeGreaterThan(0);
      for (const arg of plan.command) expect(typeof arg).toBe('string');
      expect(isAbsolute(plan.cwd)).toBe(true);
      for (const [key, value] of Object.entries(plan.env)) {
        expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(typeof value).toBe('string');
      }
    });

    it('writes the instructions to its instructions file', async () => {
      const plan = await driver.prepare(agent, context);
      const file = plan.files.find(
        (f) => normalize(f.path) === driver.capabilities.instructionsFile,
      );
      expect(file, `a planned ${driver.capabilities.instructionsFile}`).toBeDefined();
      expect(file?.content).toContain('Reply with the word ready.');
    });

    it('keeps planned files inside the session folder', async () => {
      const plan = await driver.prepare(agent, context);
      for (const file of plan.files) {
        expect(isAbsolute(file.path), file.path).toBe(false);
        expect(normalize(file.path).split(/[/\\]/)).not.toContain('..');
      }
    });

    it('passes the model to the engine', async () => {
      const plan = await driver.prepare(agent, context);
      const everything = JSON.stringify([plan.command, plan.env, plan.files]);
      expect(everything).toContain(options.model);
    });

    it('plans the same launch for the same agent', async () => {
      expect(await driver.prepare(agent, context)).toEqual(await driver.prepare(agent, context));
    });
  });
}

function isWindows(): boolean {
  return process.platform === 'win32';
}
