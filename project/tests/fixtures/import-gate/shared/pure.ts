// T29 negative-control fixture (deliberate violation, never imported by src/).
// shared/ must be a pure leaf — importing core is a boundary violation the
// import gate MUST flag. Asserted by tests/unit/gate.test.ts.
import { valueOf } from '../core/plain.ts';

export const fixtureShared: string = valueOf();
