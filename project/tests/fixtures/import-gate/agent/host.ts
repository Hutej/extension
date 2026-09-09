// T29 negative-control fixture: agent/ must not import entrypoints/.
import { entryValue } from '../entrypoints/root.ts';

export function agentValue(): string {
  return entryValue();
}
