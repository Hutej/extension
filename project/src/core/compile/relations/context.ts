/**
 * compile/relations/context — the shared context handed to every relation-domain
 * resolver. The helpers stay in transform.ts (closures over the perception + pack)
 * and are passed in here; the domain resolvers only consume `ctx.*`.
 *
 * This file defines types only — no logic — so the domain modules stay decoupled
 * from transform.ts (dependency direction: transform.ts → relations/*, never back).
 */

import type { DesignRule, DesignOp, StyleDecls, LayoutDecls } from '../../spec/index.ts';
import type { Cluster } from '../../perceive/index.ts';
import type { DesignPack, TypeRole, SurfaceTier } from '../../design/packs.ts';
import type { Subject, RelationStatement } from '../../design/vocabulary.ts';

/** Narrow a RelationStatement union to one relation variant (type-level only). */
export type RelOf<N extends RelationStatement['relation']> = Extract<RelationStatement, { relation: N }>;

/** One relation handler: runs the switch-case body for a single (relation, subject). */
export type RelationHandler = (rel: RelationStatement, c: Cluster, ctx: RelationContext) => void;

/** A map of relation name → handler, built by merging the domain modules. */
export interface RelationHandlerMap {
  [relation: string]: RelationHandler;
}

/** The shared context every domain resolver receives. Holds the pack, the
 *  perception lookups, the helper closures, and the mutable accumulators
 *  (ops/notes/accent counter) the cases mutate. */
export interface RelationContext {
  pack: DesignPack;
  byHandle: Map<string, Cluster>;

  // ── subject/reference resolution ──
  resolveSubject: (subj: Subject, contextCluster?: Cluster) => Cluster[];
  resolveReference: (ref: Subject, subjectCluster: Cluster) => Cluster[];

  // ── rule accumulation helpers ──
  ruleFor: (handle: string) => DesignRule;
  compFor: (handle: string) => DesignRule;
  addStyles: (r: DesignRule, styles: StyleDecls) => void;
  addLayout: (r: DesignRule, layout: LayoutDecls) => void;

  // ── measurement helpers ──
  fontSizePx: (c: Cluster) => number;
  paddingPx: (c: Cluster) => number;
  lineHeightValue: (c: Cluster) => number;
  shadowTier: (c: Cluster) => number;

  // ── scale/ramp helpers ──
  closestStep: (scale: number[], targetPx: number) => number;
  closestRampValue: (ramp: number[], targetPx: number) => number;
  continuousSpacing: (targetPx: number) => number;
  continuousLineHeight: (targetVal: number) => number;

  // ── op-reason derivation ──
  deriveMutationReason: (subject: Cluster, reference: Cluster | undefined, byHandle: Map<string, Cluster>) => string | null;

  // ── pack-tier mappers ──
  rankToTypeRole: (rank: number) => TypeRole;
  tierToSurface: (tier: number) => SurfaceTier;

  // ── ramp data ──
  rampRoles: TypeRole[];
  rampPx: number[];
  fineRampPx: number[];

  // ── mutable accumulators (mutated by the cases via ctx) ──
  ops: DesignOp[];
  notes: string[];
  /** Mutable accent-use counter for the pack's maxAccentCount principle. */
  accent: { count: number };
}
