import { type Plan } from '../plan';
import { AI_CONFIG, logDebug } from '../config';

export interface PlanRequest {
  intent: string;
  outline: string;
  apiKey: string;
}

export type PlanResult = 
  | { ok: true; plan: Plan }
  | { ok: false; kind: 'invalid_key' | 'rate_limited' | 'network' | 'timeout' | 'bad_output' | 'unknown'; message: string };

const systemPrompt = `You are a web interface agent.
Your goal is to satisfy the user's intent by returning a JSON plan of operations.

AVAILABLE ACTIONS:
- unlockScroll: Removes overflow:hidden on body. (No targetId needed)
- scrollToTarget: Scrolls element into view. (Requires targetId)
- clickTarget: Clicks the element. (Requires targetId)
- expandAll: Expands all collapsible elements. (Scope="page")
- collapseAll: Collapses all collapsible elements. (Scope="page")
- autoLoadMore: Automatically clicks a load-more button repeatedly. (Requires targetId, maxClicks cap)
- addShortcut: Binds a keyboard key to an action. (Requires key, do={type, targetId})

RULES:
- Reference ONLY wm-ids that appear in the outline.
- If an intent needs an action not listed above, return mode="edit" with empty operations (do NOT improvise).
- Keep/reading/focus intents => mode=isolate.
- Removal/hiding intents => mode=edit with hide ops.
- Behavior intents (shortcuts, scroll unlock, expand, click, load more) => mode=edit with act ops.
- Do not guess if nothing matches; return empty operations.`;

export let _testInjectedError: any[] | null = null;
export function setTestInjectedError(errors: any[] | null) {
  _testInjectedError = errors;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  if (_testInjectedError && _testInjectedError.length > 0) {
    const err = _testInjectedError.shift();
    if (err) {
      if (err.status) {
        return new Response(JSON.stringify(err.body || {}), { status: err.status });
      }
      if (err === 'TIMEOUT') {
        const errObj = new Error('AbortError');
        errObj.name = 'AbortError';
        throw errObj;
      }
      throw new Error(err);
    }
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

export async function requestPlan({ intent, outline, apiKey }: PlanRequest): Promise<PlanResult> {
  let attempt = 0;
  let lastErrorMsg = '';

  while (attempt < AI_CONFIG.maxRetries) {
    attempt++;
    logDebug(`[requestPlan] Attempt ${attempt} for intent: "${intent}"`);

    try {
      const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: AI_CONFIG.model,
          max_tokens: AI_CONFIG.max_tokens,
          temperature: AI_CONFIG.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Intent: ${intent}\n\nOutline:\n${outline}` }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'transform_plan',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['isolate', 'edit'] },
                  keepId: { type: ['string', 'null'] },
                  operations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        op: { type: 'string', enum: ['hide', 'act'] },
                        targetId: { type: ['string', 'null'] },
                        action: {
                          type: ['object', 'null'],
                          properties: {
                            type: { type: 'string', enum: ['unlockScroll', 'scrollToTarget', 'clickTarget', 'expandAll', 'collapseAll', 'autoLoadMore', 'addShortcut'] },
                            targetId: { type: ['string', 'null'] },
                            scope: { type: ['string', 'null'] },
                            maxClicks: { type: ['number', 'null'] },
                            key: { type: ['string', 'null'] },
                            do: {
                              type: ['object', 'null'],
                              properties: {
                                type: { type: 'string', enum: ['clickTarget', 'scrollToTarget'] },
                                targetId: { type: 'string' }
                              },
                              required: ['type', 'targetId'],
                              additionalProperties: false
                            }
                          },
                          required: ['type', 'targetId', 'scope', 'maxClicks', 'key', 'do'],
                          additionalProperties: false
                        }
                      },
                      required: ['op', 'targetId', 'action'],
                      additionalProperties: false
                    }
                  },
                  reasoning: { type: 'string' }
                },
                required: ['mode', 'keepId', 'operations', 'reasoning'],
                additionalProperties: false
              }
            }
          }
        })
      }, AI_CONFIG.timeoutMs);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, kind: 'invalid_key', message: 'Invalid API key.' };
        }
        if (response.status === 429) {
          if (attempt >= AI_CONFIG.maxRetries) return { ok: false, kind: 'rate_limited', message: 'Rate limited. Try again later.' };
          await new Promise(r => setTimeout(r, AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1)));
          continue;
        }
        if (response.status >= 500) {
          if (attempt >= AI_CONFIG.maxRetries) return { ok: false, kind: 'network', message: 'Server error. Try again later.' };
          await new Promise(r => setTimeout(r, AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1)));
          continue;
        }
        return { ok: false, kind: 'unknown', message: `HTTP Error ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0].message.content;

      let plan: Plan;
      try {
        plan = JSON.parse(content);
      } catch (e: any) {
        logDebug('JSON parse failed on LLM output:', e.message);
        lastErrorMsg = 'Failed to parse AI output.';
        continue; // Try again on parse failure
      }

      // Output Validation
      if (!Array.isArray(plan.operations)) {
        lastErrorMsg = 'Operations is not an array.';
        continue;
      }

      if (plan.operations.length > AI_CONFIG.maxOperations) {
        logDebug(`Operations array too large: ${plan.operations.length}, truncating to ${AI_CONFIG.maxOperations}`);
        plan.operations = plan.operations.slice(0, AI_CONFIG.maxOperations);
      }

      // Collect valid outline IDs for validation
      const validIds = new Set<string>();
      const outlineMatches = outline.match(/#wm-\d+/g);
      if (outlineMatches) {
        for (const match of outlineMatches) {
          validIds.add(match.substring(1));
        }
      }

      // Sanitize operations based on IDs
      const sanitizedOps = [];
      for (const op of plan.operations) {
        if (op.op === 'hide' && op.targetId) {
          if (validIds.has(op.targetId)) sanitizedOps.push(op);
        } else if (op.op === 'act' && op.action) {
          let valid = true;
          if (op.action.targetId && !validIds.has(op.action.targetId)) valid = false;
          if (op.action.scope && op.action.scope !== 'page' && !validIds.has(op.action.scope)) valid = false;
          if (op.action.do && op.action.do.targetId && !validIds.has(op.action.do.targetId)) valid = false;
          if (valid) sanitizedOps.push(op);
        }
      }
      plan.operations = sanitizedOps;

      if (plan.keepId && !validIds.has(plan.keepId)) {
        plan.keepId = undefined;
      }

      return { ok: true, plan };

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { ok: false, kind: 'timeout', message: 'Request timed out.' };
      }
      if (attempt >= AI_CONFIG.maxRetries) {
        return { ok: false, kind: 'network', message: err.message || 'Network error.' };
      }
      await new Promise(r => setTimeout(r, AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1)));
    }
  }

  return { ok: false, kind: 'bad_output', message: lastErrorMsg || "Couldn't produce a valid change." };
}
