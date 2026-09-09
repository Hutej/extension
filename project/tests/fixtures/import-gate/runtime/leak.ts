// T29 negative-control fixture: runtime/ must not import the broker or the
// legacy loop/tools (plan/02 §1: the DOM runtime sits below planner/broker).
import { brokerValue } from '../background/host.ts';

export function runtimeUsingBroker(): string {
  return brokerValue();
}
