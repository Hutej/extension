// T29 negative-control fixture: second half of the runtime cycle.
import { aValue } from './a.ts';

export function bValue(): string {
  return aValue();
}
