# Behavior, navigation and workflow recomposition

**Proposed.** Purpose: deliver the non-theming product vision with bounded declarative capabilities, not generated userscripts. Dependencies: target/action catalog, transactions, dynamic reconciliation, accessible owned UI. These are scheduled P2 work, not assumed existing features.

## 1. Native action catalog

Observation exposes action IDs for concrete capabilities: focus a focusable target; scroll a target into view; follow an existing safe link; activate an existing button; change extension-owned collapse/filter state; invoke a supported native disclosure. Each action descriptor contains targetRef, role/name, risk class, required trusted gesture, expected local state transition if observable, and supported/unknown status.

The runtime cannot know whether every arbitrary button causes a purchase/delete/send. Therefore **all generic activation actions are potentially consequential**. Installing a shortcut to one requires an explicit user review of the target label and action. Automatic rules may only use known local presentation actions or native disclosure controls with an observable expanded/open state and explicit user approval. Never auto-submit forms, fill credentials, send messages, purchase, delete, grant permissions, or cross origin through a model-authored URL.

“The backend never changes” means Revueon does not rewrite or directly integrate with a site's backend. A user activating the site's existing control can naturally cause that site's normal network request. This distinction must appear in approval UI. Revueon does not reverse those external effects; undo removes the installed shortcut, not a sent email.

## 2. Keyboard binding contract

Inputs: chord (normalized key plus modifiers), action ID or finite sequence, activation scope (current target region/document), repeat policy default false. At most 20 bindings/document and 4 steps per explicit gesture. Chords conflict with browser-reserved combinations, an existing Revueon binding or editable surfaces → reject/offer alternatives. Browser-reserved chords may not be interceptable; do not promise them.

Dispatch requirements:

1. Event is trusted; ignore composition (`isComposing`), dead keys and unwanted repeats.
2. Inspect composed event path for input, textarea, select, contenteditable, active dialog or menu. Default: no interception there. User can opt into narrow application scopes, never global interception of password editing.
3. Resolve current target/action and check it is visible, enabled and within the approved scope. No first-match activation.
4. Call preventDefault only after an eligible action has been selected; never consume unrelated keys.
5. Execute locally while gesture is current. A model call or long await cannot preserve trusted activation; clipboard/fullscreen/media/playback restrictions remain browser enforced.
6. Report result and release resources on disable. No repeated synthetic click retries. `isTrusted` cannot be manufactured.

For Gmail keyboard-first, map approved shortcuts to existing controls, navigation/focus and extension command palette entries; do not introspect private framework stores or dispatch hidden Gmail APIs.

## 3. Local rules

Grammar is finite: trigger (`target-appeared`, `trusted-shortcut`, `local-toggle`), predicate (observed membership plus explicit local state), action (owned hide/collapse/style/focus, or approved native disclosure), maxExecutions per target instance, cooldown, and once/until-disabled policy. No arbitrary expression evaluator or model-written loop.

Example design: auto-collapse Reddit comments:

- Observe current comment containers and disclosure affordance with expanded-state evidence.
- Preferred: install user-approved rule that collapses only initially expanded new comment instances through an identifiable disclosure; verify collapsed state, one attempt per instance.
- Alternative: local owned collapse UI that leaves original subtree mounted and offers expand.
- If action requires app-specific trusted interaction or target identity is ambiguous: manual shortcut/user selection; do not spam click until it happens.
- If user expands a comment afterward, respect that override for the current instance; observer must not re-collapse it continuously. An original expanded state is not a mandate to overwrite later user choice during cleanup.

Replay installs the rule, not prior click events. Rules don't contact providers. Mutation storms pause further rule application with visible diagnostic.

## 4. Projection views instead of cloned applications

A projection is an extension-owned representation of observed source items, linked to the live original. The website remains source of truth; the projection owns only layout, grouping and explicit local organization.

Supported first views: list, grid, board. Input: source set descriptor, fields from observed DOM (`title`, `label`, safe source link, explicit category), grouping field or user-local bucket, stable item key, order, source reveal action. Model chooses a mapping **from available fields**; cannot invent unseen pull-request status, author or priority.

Board behavior:

- Render text and links using structured nodes, not source `innerHTML`.
- A move between columns is **local organization only** unless user explicitly invokes the original site's approved control. Label this clearly.
- Persist local grouping only with stable source item keys (typically origin-relative canonical link without sensitive query; otherwise session-only).
- At most 200 rendered items; show loaded/total-known coverage. Paginate first; virtualization only if measured need appears.
- Observe field changes and source detach; update projection in slices. If source key duplicates or disappears, disable affected actions and mark stale. Never act on a newly recycled row merely because it occupies the same position.
- Provide “Show original” without destroying projection configuration. Do not automatically hide the only original interactive UI before projection parity is established and user approves.
- Projection clicks focus/reveal or follow current safe source link. It is not a copy of the site's live native controls.

GitHub PR Kanban therefore has a real path: discover list, expose title/status/label/link fields, create grouped view, retain access to original PR interactions. Cross-page aggregation is out of scope until explicit retrieval permission and pagination semantics are designed; initial view covers loaded items and says so.

## 5. Floating controls and structural relocation

For Spotify mini-player, first style the **existing** player using fixed/sticky position and responsive max size. This preserves the actual audio element and handlers. Check clipping/stacking, keyboard controls and minimize/restore. Do not duplicate `<audio>`/`video>` or synthesize a decorative player disconnected from playback.

When CSS cannot escape overflow/stacking, alternatives in order:

1. Owned control panel linking/focusing existing player controls, without moving media.
2. Gated relocation of an existing container with explicit user approval and tested attachment behavior.
3. Keep original placement, report limitation.

Relocation preserves live node reference and placeholder, parent and next sibling. Reject document/body roots, script/style, iframe, editor/form, canvas/media node itself and unknown custom-element lifecycle-sensitive nodes in initial implementation. Listener preservation alone does not prove relocation safe: framework reconciliation, CSS inheritance, form ownership, focus and connected callbacks can change. Browser tests must prove function and restoration; if site fights it twice, suspend relocation for that document and offer projection/CSS fallback.

## 6. Vision examples and concrete scope

| Example | Mechanism | Non-negotiable limitation |
|---|---|---|
| Hide YouTube Shorts permanently | Approved future-set hide + origin/path scope + mutation reconciliation | If no safe set predicate, current-target/session hide plus user selection; no unrelated cards |
| Remove X For You tab | Hide verified tab; retain Following/navigation and accessible focus | Do not change account preferences or click backend settings automatically |
| Glassmorphism/neobrutalism/90s/Notion style | General style declaration groups, tokens, responsive layout | No remote fonts/assets by default; readability and reduced motion preserved |
| Wikipedia magazine | Typography/columns/media layout; optional section projection | Preserve source links, code and heading navigation; don't replace entire article DOM |
| YouTube into Spotify | Audio-focused layout, source player/control projection, navigation density | No pretending video streaming service/backend changed |
| Amazon into Apple | Product presentation/theme/layout with existing purchase controls intact | Never create deceptive/rebound purchase actions |
| LinkedIn one post/screen | Future-set layout with bounded snap/spacing and original scroll access | Virtualized item ownership stays with site; no absolute reconstruction of all posts |
| LinkedIn bait filtering | User-approved explicit predicate or model-labeled current items | Subjective general classification quality is not guaranteed without future inference |
| Increase spacing/reduce clutter | Small scoped style/hide groups and visible verification | Do not treat every large blank region as an ad |

## 7. Tests and release gates

[Matrix T15–T18](21-test-matrix.md): editing/IME, duplicate shortcut, OS-reserved chord, modal focus, generic activation refusal, native disclosure idempotency and user override, projection stale key, card drag local-only, same-node media preservation, relocation framework replacement, disable during key event. Every behavior has install/uninstall/reload tests. No feature is declared complete merely because its registry entry exists.
