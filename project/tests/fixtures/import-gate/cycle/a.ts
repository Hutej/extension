// T29 negative-control fixture: a RUNTIME cycle (a.ts -> b.ts -> a.ts).
import { bValue } from './b.ts';

export function aValue(): string {
  return bValue();
}
