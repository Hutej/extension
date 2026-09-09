// T29 negative-control fixture: tools/ must not import agent/.
import { agentValue } from '../agent/host.ts';

export function toolValue(): string {
  return agentValue();
}
