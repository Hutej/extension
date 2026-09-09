// T29 negative-control fixture: core/ must not import tools/.
import { toolValue } from '../tools/impl.ts';

export function coreUsingTool(): string {
  return toolValue();
}
