import type { LoadedWorkspace } from '../config/load.js';
import type { TeamMember } from './builtin.js';

/** A workspace's agents other than its chief: the team the chief hands work to (docs/team.md). */
export function teamOf(workspace: LoadedWorkspace): TeamMember[] {
  const chief = workspace.config?.chief_of_staff;
  return workspace.agents
    .filter((a) => a.definition.name !== chief)
    .map((a) => ({
      name: a.definition.name,
      description: a.definition.description,
      engine: a.definition.engine,
      model: a.definition.model,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether an agent is its workspace's chief of staff. */
export function isChief(workspace: LoadedWorkspace, name: string): boolean {
  return workspace.config?.chief_of_staff === name;
}
