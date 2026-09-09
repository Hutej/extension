// T29 control: second half of the type-only cycle.
import type { TValue } from './a.ts';

export interface TOther {
  m: number;
}
export function typeB(v: TValue, o: TOther): number {
  return v.n + o.m;
}
