import { relative } from 'node:path';
import type { LoadedInstall, LoadedWorkspace, Problem } from './load.js';

export interface CrossCheckOptions {
  /** Engine drivers that are registered. Agents naming another engine get a warning. */
  engines?: string[];
}

const BUILT_IN_CHANNELS = ['chat', 'approvals', 'updates'] as const;

/**
 * Checks what one file cannot check alone: that names point at things that exist
 * and that each level only picks from the level above (install, workspace, agent).
 */
export function crossCheck(install: LoadedInstall, options: CrossCheckOptions = {}): Problem[] {
  const problems: Problem[] = [];
  const installConfig = install.config;
  if (!installConfig) return problems;

  const accounts = new Set(Object.keys(installConfig.accounts));
  const connections = new Set(Object.keys(installConfig.connections));
  const machines = new Set(Object.keys(installConfig.machines));

  for (const workspace of install.workspaces) {
    const config = workspace.config;
    if (!config) continue;
    const file = `${rel(install, workspace)}/workspace.yaml`;
    const error = (message: string, inFile = file) =>
      problems.push({ level: 'error', file: inFile, message });
    const warn = (message: string, inFile = file) =>
      problems.push({ level: 'warning', file: inFile, message });

    for (const account of config.accounts) {
      if (!accounts.has(account)) error(`Account "${account}" is not in install.yaml`);
    }
    for (const [name, binding] of Object.entries(config.channels)) {
      if (!connections.has(binding.connection)) {
        error(
          `Channel "${name}" uses connection "${binding.connection}", which is not in install.yaml`,
        );
      }
    }
    for (const name of BUILT_IN_CHANNELS) {
      if (!Object.hasOwn(config.channels, name))
        warn(`No "${name}" channel yet; every workspace gets one`);
    }
    for (const name of Object.keys(config.integrations)) {
      if (!connections.has(name))
        error(`Integration "${name}" is not a connection in install.yaml`);
    }
    if (config.machine !== undefined && !machines.has(config.machine)) {
      error(`Machine "${config.machine}" is not in install.yaml`);
    }

    const agentNames = new Set(workspace.agents.map((a) => a.definition.name));
    if (!agentNames.has(config.chief_of_staff)) {
      error(`The chief of staff "${config.chief_of_staff}" has no file in agents/`);
    }
    for (const rule of config.rules) {
      if (rule.require && !agentNames.has(rule.require.review)) {
        error(
          `Rule "${rule.name}" requires a review by "${rule.require.review}", which has no file in agents/`,
        );
      }
      if (rule.approval !== undefined && !Object.hasOwn(config.channels, rule.approval)) {
        error(
          `Rule "${rule.name}" asks for approval in "${rule.approval}", which is not one of its channels`,
        );
      }
    }

    const pinned = new Set(Object.keys(workspace.skills?.skills ?? {}));
    if (pinned.size > config.skill_budget) {
      warn(
        `${pinned.size} skills is over the budget of ${config.skill_budget}`,
        `${rel(install, workspace)}/skills.yaml`,
      );
    }

    for (const agent of workspace.agents) {
      const { definition } = agent;
      if (!config.accounts.includes(definition.account)) {
        error(`Account "${definition.account}" is not one of the workspace's accounts`, agent.file);
      }
      for (const skill of definition.skills) {
        if (!pinned.has(skill))
          error(`Skill "${skill}" is not in the workspace's skills.yaml`, agent.file);
      }
      if (definition.skills.length > config.skill_budget) {
        warn(
          `${definition.skills.length} skills is over the budget of ${config.skill_budget}`,
          agent.file,
        );
      }
      for (const integration of definition.integrations) {
        if (!Object.hasOwn(config.integrations, integration)) {
          error(
            `Integration "${integration}" is not one of the workspace's integrations`,
            agent.file,
          );
        }
      }
      if (options.engines && !options.engines.includes(definition.engine)) {
        warn(`No engine driver "${definition.engine}" is installed yet`, agent.file);
      }
    }

    for (const workflow of workspace.workflows) {
      const { trigger, steps } = workflow.config;
      if ('message' in trigger && !Object.hasOwn(config.channels, trigger.message.channel)) {
        error(
          `Trigger channel "${trigger.message.channel}" is not one of the workspace's channels`,
          workflow.file,
        );
      }
      for (const step of steps) {
        if ('agent' in step && !agentNames.has(step.agent)) {
          error(`Step agent "${step.agent}" has no file in agents/`, workflow.file);
        }
        const channel =
          'post' in step ? step.post.channel : 'ask' in step ? step.ask.channel : undefined;
        if (channel !== undefined && !Object.hasOwn(config.channels, channel)) {
          error(`Channel "${channel}" is not one of the workspace's channels`, workflow.file);
        }
      }
    }
  }
  return problems;
}

function rel(install: LoadedInstall, workspace: LoadedWorkspace): string {
  return relative(install.home, workspace.dir);
}
