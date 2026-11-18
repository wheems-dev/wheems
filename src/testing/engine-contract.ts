import { isAbsolute, normalize } from 'node:path';
import { beforeAll, describe, expect, it } from 'bun:test';
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
    const root = isWindows() ? 'C:\\wheems-contract' : '/wheems-contract';
    const agent: AgentDefinition = {
      name: 'contract-agent',
      description: 'An agent used by the engine contract tests',
      engine: '',
      model: options.model,
      account: 'contract-account',
      skills: [],
      integrations: [],
      permissions: 'ask',
      instructions: '# Contract agent\n\nReply with the word ready.',
    };
    const context: EngineContext = {
      workspace: { id: 'contract', dir: `${root}/workspaces/contract` },
      sessionDir: `${root}/workspaces/contract/sessions/contract-agent`,
      account: { name: 'contract-account', driver: options.accountDriver },
      session: {
        id: '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f',
        resume: false,
        task: null,
        engineId: null,
      },
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
      for (const key of ['skills', 'mcp', 'hooks', 'permissions', 'resume', 'status'] as const) {
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

    it('writes the instructions to AGENTS.md, which its instructions file is or points to', async () => {
      const plan = await driver.prepare(agent, context);
      const agents = plan.files.find((f) => normalize(f.path) === 'AGENTS.md');
      expect(agents, 'a planned AGENTS.md').toBeDefined();
      expect(agents?.content).toContain('Reply with the word ready.');
      const file = plan.files.find(
        (f) => normalize(f.path) === driver.capabilities.instructionsFile,
      );
      expect(file, `a planned ${driver.capabilities.instructionsFile}`).toBeDefined();
      if (driver.capabilities.instructionsFile !== 'AGENTS.md') {
        // An engine that reads another file reads AGENTS.md through it (docs/instructions.md).
        expect(file?.content).toMatch(/^@AGENTS\.md$/m);
      }
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

    it('names the conversation, and carries it on when resuming', async () => {
      const fresh = await driver.prepare(agent, context);
      // An engine that chooses its own ids finds them later (findSession); others take Wheems's.
      if (!driver.findSession) expect(JSON.stringify(fresh)).toContain(context.session.id);
      // An engine that can't resume has nothing more to show here.
      if (!driver.capabilities.resume) return;
      const engineId = driver.findSession ? 'contract-engine-session' : context.session.id;
      const resumed = await driver.prepare(agent, {
        ...context,
        session: { ...context.session, resume: true, engineId },
      });
      expect(JSON.stringify(resumed)).toContain(engineId);
      expect(resumed.command).not.toEqual(fresh.command);
    });

    it('hands the agent its first task', async () => {
      const task = 'Say the word ready, then wait. --not-an-option';
      const plan = await driver.prepare(agent, {
        ...context,
        session: { ...context.session, task },
      });
      expect(JSON.stringify([plan.command, plan.env, plan.files])).toContain(
        JSON.stringify(task).slice(1, -1),
      );
    });

    it('plans every permission level', async () => {
      for (const permissions of ['ask', 'auto', 'skip'] as const) {
        const plan = await driver.prepare({ ...agent, permissions }, context);
        expect(plan.command.length).toBeGreaterThan(0);
      }
    });
  });
}

function isWindows(): boolean {
  return process.platform === 'win32';
}
