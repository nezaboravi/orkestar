const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(value);
export const teamRoles = ['mid', 'economy', 'strongest'];
const titles = { mid: 'Implementation worker', economy: 'Light checks', strongest: 'Independent reviewer' };
export function validWorkerRoute(route) {
  return route && ['codex', 'claude'].includes(route.harness) && modelName(route.model)
    && ['low', 'medium', 'high'].includes(route.effort) && ['auto', 'manual'].includes(route.mode);
}
export function validTeam(team, primary) {
  return team?.schemaVersion === 1 && teamRoles.every(role => validWorkerRoute(team[role]))
    && team.strongest.model !== primary && team.strongest.model !== team.mid.model;
}
function autoRoute(catalog, role, excluded) {
  const order = role === 'strongest' ? ['gpt-5.6-sol', 'opus', 'gpt-6-astra']
    : role === 'economy' ? ['gpt-5.6-luna', 'haiku', 'gpt-5.6-terra', 'sonnet'] : ['gpt-5.6-terra', 'sonnet', 'gpt-5.6-sol'];
  for (const model of order) {
    const route = catalog.find(item => item.model === model && !excluded.includes(item.model));
    if (route) return route;
  }
  return null;
}
export async function chooseTeam({ catalog, primary, question, write }) {
  const team = { schemaVersion: 1 };
  for (const role of teamRoles) {
    const excluded = role === 'strongest' ? [primary, team.mid.model] : [];
    const choices = catalog.filter(item => !excluded.includes(item.model));
    if (!choices.length) throw new Error('No different reviewer model is available. Sign in to another worker CLI before setting up this team.');
    const recommended = autoRoute(choices, role, excluded);
    write(`\n${titles[role]} — choose the actual CLI and model:`);
    write(`  0. Auto${recommended ? ` → ${recommended.harness} / ${recommended.model}` : ' — unavailable for this model inventory'}`);
    choices.forEach((item, index) => write(`  ${index + 1}. ${item.harness} / ${item.model}`));
    const answer = (await question('Selection [0]: ')).trim() || '0';
    const index = /^\d+$/.test(answer) ? Number(answer) : -1;
    const route = index === 0 ? recommended : choices[index - 1];
    if (!route) throw new Error('Choose a listed model; no team choices were saved.');
    const defaultEffort = role === 'strongest' ? 'high' : role === 'economy' ? 'low' : 'medium';
    const levels = route.efforts.filter(level => ['low', 'medium', 'high'].includes(level));
    const fallback = levels.includes(defaultEffort) ? defaultEffort : levels[0];
    if (!fallback) throw new Error('No verified effort is available for this route');
    write(`  Effort: auto (${fallback}), ${levels.join(', ')}`);
    const effortAnswer = (await question('Effort [auto]: ')).trim().toLowerCase() || 'auto';
    const effort = effortAnswer === 'auto' ? fallback : effortAnswer;
    if (!levels.includes(effort)) throw new Error('Unsupported effort; no team choices were saved');
    team[role] = { harness: route.harness, model: route.model, effort, mode: index === 0 ? 'auto' : 'manual' };
  }
  if (!validTeam(team, primary)) throw new Error('Reviewer must use a different model from Lenka and the implementation worker');
  write('\nSelected workers (separate CLI sessions):');
  teamRoles.forEach(role => write(`- ${titles[role]}: ${team[role].harness} / ${team[role].model} / ${team[role].effort} (${team[role].mode})`));
  const answer = (await question('Save this team for this computer? [Y/n]: ')).trim().toLowerCase();
  if (!['', 'y', 'yes'].includes(answer)) throw new Error('Team selection cancelled; previous choices unchanged');
  return team;
}
export function teamInstructions(harness) {
  return `\n\nCross-CLI team: this project has an explicitly selected external worker team. Read .agent-orchestra/runtime/${harness}.json externalWorkers before delegation. For implementation, light checks and independent review, use the selected CLI route through: lenka delegate --harness ${harness} --role mid|economy|strongest --task PROJECT_FILE. PROJECT_FILE is a project-local JSON object with goal, required (acceptance strings), and optional ownership (relative file paths for implementation). The wrapper enforces the selected CLI/model/effort, project scope and two launches per immutable task contract. Use the same goal and required criteria for implementation and review. Never replace a selected external worker with a native same-model child. A worker result is evidence, not automatic acceptance; inspect it and report incomplete output honestly. Review must use a different model from both Lenka and the implementation worker. Do not run raw cross-CLI commands to bypass this wrapper.\n`;
}
