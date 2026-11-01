import { useEffect, useState } from 'react';
import { listAgents } from '../api';
import { agentFileModel, resolveModelName } from '../llm/models';
import { getModel } from '../store/apiKey';

/** What a phase's "Default" model resolves to: its agent file's `model:`,
 *  else the run's model from Settings. */
export function useDefaultModel(agentPath: string | undefined): { model: string; source: string } {
  const [agentModel, setAgentModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    const name = /^agents\/(.+)\.md$/.exec(agentPath?.trim() ?? '')?.[1];
    if (!name) {
      setAgentModel(undefined);
      return;
    }
    let live = true;
    listAgents()
      .then(list => {
        const raw = list.find(a => a.name === name)?.raw;
        if (live) setAgentModel(raw ? resolveModelName(agentFileModel(raw)) : undefined);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agentPath]);
  return agentModel
    ? { model: agentModel, source: 'from the agent file' }
    : { model: getModel(), source: 'from Settings' };
}
