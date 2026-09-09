// T29 control: a TYPE-ONLY cycle must NOT be flagged (types are erased).
import type { TOther } from './b.ts';

export interface TValue {
  n: number;
}
export function typeA(v: TValue, o: TOther): number {
  return v.n + o.m;
}
