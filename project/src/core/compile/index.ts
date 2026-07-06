/**
 * Compile layer — Operation → CSS compiler.
 * EMPTY: typed interface only, implementation in a later step.
 */

import type { Plan } from '../plan';

/** Compiled CSS output ready for injection. */
export interface CompiledStyles {
  /** The raw CSS text to inject. */
  css: string;
}

/** Compiler contract — not implemented yet. */
export interface Compiler {
  compile(plan: Plan): CompiledStyles;
}
