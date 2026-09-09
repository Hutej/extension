// T29 negative-control fixture: background/ must not import DOM executors
// (plan/03: no broker module imports runtime executors).
import { runtimeValue } from '../runtime/host.ts';

export function brokerValue(): string {
  return runtimeValue();
}
