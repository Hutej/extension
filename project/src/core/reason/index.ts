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

AVAILABLE OPERATIONS:
- hide: Hides an element by its wm-id. (Requires targetId)
- isolate: Keeps only a specific element visible (reading/focus mode). (Requires keepId)
- act: Executes a behavior action.

AVAILABLE ACTIONS (for "act" operations):
- unlockScroll: Removes overflow:hidden on body. (No targetId needed)
- scrollToTarget: Scrolls element into view. (Requires targetId)
- clickTarget: Clicks the element. (Requires targetId)
- expandAll: Expands all collapsible elements. (Scope="page")
- collapseAll: Collapses all collapsible elements. (Scope="page")
- autoLoadMore: Automatically clicks a load-more button repeatedly. (Requires targetId, maxClicks cap)
- addShortcut: Binds a keyboard key to an action. (Requires key, do={type, targetId})

RULES:
- Reference ONLY wm-ids that appear in the outline.
- If an intent needs an action not listed above, return empty operations (do NOT improvise).
- Keep/reading/focus intents => use an isolate operation with the keepId of the content to focus on.
- Removal/hiding intents => use hide operations.
- Behavior intents (shortcuts, scroll unlock, expand, click, load more) => use act operations.
- Do not guess if nothing matches; return empty operations.

You MUST format your output as a pure JSON object matching this schema exactly:
{
  "type": "object",
  "properties": {
    "operations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "op": { "type": "string", "enum": ["hide", "isolate", "act"] },
          "targetId": { "type": ["string", "null"] },
          "keepId": { "type": ["string", "null"] },
          "action": {
            "type": ["object", "null"],
            "properties": {
              "type": { "type": "string", "enum": ["unlockScroll", "scrollToTarget", "clickTarget", "expandAll", "collapseAll", "autoLoadMore", "addShortcut"] },
              "targetId": { "type": ["string", "null"] },
              "scope": { "type": ["string", "null"] },
              "maxClicks": { "type": ["number", "null"] },
              "key": { "type": ["string", "null"] },
              "do": {
                "type": ["object", "null"],
                "properties": {
                  "type": { "type": "string", "enum": ["clickTarget", "scrollToTarget"] },
                  "targetId": { "type": "string" }
                },
                "required": ["type", "targetId"],
                "additionalProperties": false
              }
            },
            "required": ["type", "targetId", "scope", "maxClicks", "key", "do"],
            "additionalProperties": false
          }
        },
        "required": ["op", "targetId", "keepId", "action"],
        "additionalProperties": false
      }
    },
    "reasoning": { "type": "string" }
  },
  "required": ["operations", "reasoning"],
  "additionalProperties": false
}
`;

let _testInjectedError: any[] | null = null;
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
      const payload = JSON.stringify({
        model: AI_CONFIG.model,
        max_completion_tokens: AI_CONFIG.max_tokens,
        temperature: AI_CONFIG.temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Intent: ${intent}\n\nOutline:\n${outline}` }
        ],
        response_format: {
          type: 'json_object'
        }
      });
      console.log(`[requestPlan] Sending payload: ${payload}`);

      const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: payload
      }, AI_CONFIG.timeoutMs);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, kind: 'invalid_key', message: 'Invalid API key.' };
        }
        if (response.status === 429) {
          if (attempt >= AI_CONFIG.maxRetries) return { ok: false, kind: 'rate_limited', message: 'Rate limited. Try again later.' };
          let waitMs = AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1);
          try {
            const errText = await response.text();
            let errBody: any = '';
            try { errBody = JSON.parse(errText)?.error?.message || ''; } catch (e) { errBody = errText; }
            
            const matchS = errBody.match(/try again in (?:(\d+)m)?([\d\.]+)s/);
            if (matchS) {
              const mins = matchS[1] ? parseInt(matchS[1]) : 0;
              waitMs = Math.ceil((mins * 60 + parseFloat(matchS[2])) * 1000) + 1000;
            } else {
              waitMs = AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1);
            }
            if (waitMs > 10000) attempt = 0;
          } catch (e) {
            console.log("Error parsing 429", e);
            waitMs = AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1);
          }
          console.log(`[requestPlan] Waiting ${waitMs}ms before retry...`);
          const interval = setInterval(() => {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getPlatformInfo) {
              chrome.runtime.getPlatformInfo();
            }
          }, 10000);
          await new Promise(r => setTimeout(r, waitMs));
          clearInterval(interval);
          continue;
        }
        if (response.status >= 500) {
          if (attempt >= AI_CONFIG.maxRetries) return { ok: false, kind: 'network', message: 'Server error. Try again later.' };
          await new Promise(r => setTimeout(r, AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1)));
          continue;
        }
        const errText = await response.text();
        console.error(`[requestPlan] HTTP Error ${response.status}: ${errText}`);
        return { ok: false, kind: 'unknown', message: `HTTP Error ${response.status}: ${errText}` };
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
        } else if (op.op === 'isolate' && op.keepId) {
          if (validIds.has(op.keepId)) sanitizedOps.push(op);
        } else if (op.op === 'act' && op.action) {
          let valid = true;
          if (op.action.targetId && !validIds.has(op.action.targetId)) valid = false;
          if (op.action.scope && op.action.scope !== 'page' && !validIds.has(op.action.scope)) valid = false;
          if (op.action.do && op.action.do.targetId && !validIds.has(op.action.do.targetId)) valid = false;
          if (valid) sanitizedOps.push(op);
        }
      }
      plan.operations = sanitizedOps;

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
