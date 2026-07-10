import { type Plan } from '../plan';
import { type TransformBundle } from '../bundle';
import { AI_CONFIG, logDebug } from '../config';

// ── Types ──────────────────────────────────────────────────────────

export async function classifyIntent(intent: string, apiKey: string): Promise<'theme' | 'plan' | 'unknown'> {
  try {
    const payload = JSON.stringify({
      model: AI_CONFIG.classifierModel,
      max_completion_tokens: 50,
      temperature: 0.1,
      messages: [
        { role: 'system', content: `Classify the user's web page modification intent. Output exactly one of the following words in JSON format:
- "theme" if the user wants to globally re-skin, style, or change the aesthetic of the entire page (e.g., "dark mode", "neobrutalism", "make it look like 90s").
- "plan" if the user wants to hide, remove, isolate, click, or scroll specific elements, or add keyboard shortcuts.

Respond with JSON: { "classification": "theme" | "plan" }` },
        { role: 'user', content: intent }
      ],
      response_format: { type: 'json_object' }
    });

    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: payload
    }, AI_CONFIG.timeoutMs);

    if (!response.ok) return 'unknown';

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    
    if (parsed.classification === 'theme') return 'theme';
    if (parsed.classification === 'plan') return 'plan';
    return 'unknown';
  } catch (err) {
    logDebug('classifyIntent error:', err);
    return 'unknown';
  }
}

export interface PlanRequest {
  intent: string;
  outline: string;
  apiKey: string;
}

export interface ThemeRequest {
  intent: string;
  designContext: string;
  outline: string;
  apiKey: string;
}

export type PlanResult = 
  | { ok: true; plan: Plan }
  | { ok: false; kind: 'invalid_key' | 'rate_limited' | 'network' | 'timeout' | 'bad_output' | 'context_limit' | 'invalid_request' | 'unknown'; message: string };

export type ThemeResult =
  | { ok: true; bundle: TransformBundle; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { ok: false; kind: 'invalid_key' | 'rate_limited' | 'network' | 'timeout' | 'bad_output' | 'context_limit' | 'invalid_request' | 'unknown'; message: string };

// ── DEV-only test injection (dead-code-eliminated in production) ──

let _testInjectedError: any[] | null = null;

export function setTestInjectedError(errors: any[] | null) {
  if (import.meta.env.DEV) {
    _testInjectedError = errors;
  }
}

// ── System prompts ─────────────────────────────────────────────────

const planSystemPrompt = `You are a web interface agent.
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

const themeSystemPrompt = `You are a fast design agent.
Given a user intent, design context, and semantic roles summary, author a COMPACT, CSS-variable-driven theme.

RULES:
1. Output MUST be extremely brief. Rely mostly on setting :root CSS variables and targeting high-impact elements (body, main, nav, header, button, a).
2. DO NOT write exhaustive selectors. Use generic grouping where possible.
3. Define a cohesive palette in :root (e.g., --bg, --text, --accent, --border, --radius, --shadow).
4. Apply these variables globally where appropriate, using !important to override existing styles.
5. Provide ONLY the CSS variables and minimal element overrides needed to achieve the aesthetic.
6. The entire CSS should easily fit in a few hundred tokens.

You MUST respond with a JSON object matching this schema exactly:
{
  "themeCss": "<your complete CSS string>",
  "reasoning": "<brief 1-sentence reasoning>"
}
Return ONLY valid JSON.`;

// ── HTTP transport ─────────────────────────────────────────────────

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  // DEV-only test injection — dead-code-eliminated from production build
  if (import.meta.env.DEV) {
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

// ── Shared retry/backoff handler ───────────────────────────────────

async function handleRetryableResponse(
  response: Response,
  attempt: number,
  maxRetries: number
): Promise<{ action: 'retry' | 'fatal'; result?: PlanResult | ThemeResult }> {
  if (response.status === 401 || response.status === 403) {
    return { action: 'fatal', result: { ok: false, kind: 'invalid_key', message: 'Invalid API key.' } };
  }
  if (response.status === 429) {
    if (attempt >= maxRetries) return { action: 'fatal', result: { ok: false, kind: 'rate_limited', message: 'Rate limited. Try again later.' } };
    let waitMs = AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1);
    try {
      const errText = await response.text();
      let errBody: any = '';
      try { errBody = JSON.parse(errText)?.error?.message || ''; } catch (_e) { errBody = errText; }
      
      const matchS = errBody.match(/try again in (?:(\d+)m)?([\d.]+)s/);
      if (matchS) {
        const mins = matchS[1] ? parseInt(matchS[1]) : 0;
        waitMs = Math.ceil((mins * 60 + parseFloat(matchS[2])) * 1000) + 1000;
      }
    } catch (_e) {
      logDebug('Error parsing 429 body');
    }
    logDebug(`[retry] Waiting ${waitMs}ms before retry...`);
    const interval = setInterval(() => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getPlatformInfo) {
        chrome.runtime.getPlatformInfo();
      }
    }, 10000);
    await new Promise(r => setTimeout(r, waitMs));
    clearInterval(interval);
    return { action: 'retry' };
  }
  if (response.status >= 500) {
    if (attempt >= maxRetries) return { action: 'fatal', result: { ok: false, kind: 'network', message: 'Server error. Try again later.' } };
    await new Promise(r => setTimeout(r, AI_CONFIG.baseBackoffMs * Math.pow(2, attempt - 1)));
    return { action: 'retry' };
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403 && response.status !== 429) {
    const errText = await response.text();
    logDebug(`[FATAL] HTTP Error ${response.status}: ${errText}`);
    
    let kind = 'bad_output';
    let message = `HTTP Error ${response.status}: ${errText}`;
    
    if (response.status === 400 && errText.toLowerCase().includes('context_length_exceeded')) {
      kind = 'context_limit';
      message = 'Page structure is too large for the AI to process.';
    } else if (response.status === 400) {
      kind = 'invalid_request';
      message = 'The AI model rejected the request format.';
    }
    
    return { action: 'fatal', result: { ok: false, kind, message } };
  }
  const errText = await response.text();
  logDebug(`HTTP Error ${response.status}: ${errText}`);
  return { action: 'fatal', result: { ok: false, kind: 'unknown', message: `HTTP Error ${response.status}: ${errText}` } };
}

// ── requestPlan (existing hide/isolate/act path) ───────────────────

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
          { role: 'system', content: planSystemPrompt },
          { role: 'user', content: `Intent: ${intent}\n\nOutline:\n${outline}` }
        ],
        response_format: {
          type: 'json_object'
        }
      });
      logDebug(`[requestPlan] Sending payload (${payload.length} chars)`);
      logDebug(`[requestPlan] Outline chars: ${outline.length}`);

      const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: payload
      }, AI_CONFIG.timeoutMs);

      if (!response.ok) {
        const h = await handleRetryableResponse(response, attempt, AI_CONFIG.maxRetries);
        if (h.action === 'fatal') return h.result as PlanResult;
        continue; // retry
      }

      const data = await response.json();
      const content = data.choices[0].message.content;

      let plan: Plan;
      try {
        plan = JSON.parse(content);
      } catch (e: any) {
        logDebug('JSON parse failed on LLM output:', e.message);
        lastErrorMsg = 'Failed to parse AI output.';
        continue;
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

// ── requestTheme (NEW: Tier-1 re-skin path) ────────────────────────

export async function requestTheme({ intent, designContext, outline, apiKey }: ThemeRequest): Promise<ThemeResult> {
  let attempt = 0;
  let lastErrorMsg = '';

  while (attempt < AI_CONFIG.maxRetries) {
    attempt++;
    logDebug(`[requestTheme] Attempt ${attempt} for intent: "${intent}"`);

    try {
      const userContent = `INTENT: ${intent}

DESIGN CONTEXT (current page):
${designContext}

PAGE STRUCTURE (semantic outline):
${outline}`;

      const payload = JSON.stringify({
        model: AI_CONFIG.model,
        max_completion_tokens: AI_CONFIG.themeMaxTokens,
        temperature: AI_CONFIG.themeTemperature,
        messages: [
          { role: 'system', content: themeSystemPrompt },
          { role: 'user', content: userContent }
        ],
        response_format: {
          type: 'json_object'
        }
      });
      logDebug(`[requestTheme] Sending payload (${payload.length} chars)`);
      logDebug(`[requestTheme] Outline chars: ${outline.length}, DesignContext chars: ${designContext.length}`);

      const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: payload
      }, AI_CONFIG.themeTimeoutMs);

      if (!response.ok) {
        const h = await handleRetryableResponse(response, attempt, AI_CONFIG.maxRetries);
        if (h.action === 'fatal') return h.result as ThemeResult;
        continue;
      }

      const data = await response.json();
      const content = data.choices[0].message.content;
      const usage = data.usage;

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (e: any) {
        logDebug('JSON parse failed on theme output:', e.message);
        lastErrorMsg = 'Failed to parse AI theme output.';
        continue;
      }

      if (!parsed.themeCss || typeof parsed.themeCss !== 'string') {
        lastErrorMsg = 'Missing or invalid themeCss in AI output.';
        continue;
      }

      const bundle: TransformBundle = {
        themeCss: parsed.themeCss,
        reasoning: parsed.reasoning || '',
      };

      return { ok: true, bundle, usage };

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

  return { ok: false, kind: 'bad_output', message: lastErrorMsg || "Couldn't produce a valid theme." };
}
