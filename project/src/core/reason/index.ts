import { type Plan } from '../plan';

const MODEL_NAME = 'gpt-4o-mini';

export interface PlanRequest {
  intent: string;
  outline: string;
  apiKey: string;
}

export async function requestPlan({ intent, outline, apiKey }: PlanRequest): Promise<Plan> {
  const systemPrompt = `You are WebMorph's targeting engine. You are given a semantic outline of a web page (roles, names, ids, and optional flags like repeated or preview) and a user intent.
Choose how to transform the page to satisfy the intent.
- For any "keep only / just / reading mode / focus on X" style request, you MUST use kind="isolate" with a single keepId identifying the subtree to keep.
- For requests to remove or hide specific elements, use kind="hide" and provide an array of targetIds to hide.
Return ONLY elements whose wm-id appears in the outline. You do NOT write CSS or selectors.
You may target containers with 'repeated', heading-borrowed names, or 'preview' labels when the intent clearly matches. Do not guess if nothing matches.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
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
              kind: { type: 'string', enum: ['isolate', 'hide'] },
              keepId: { type: ['string', 'null'] },
              targetIds: {
                type: 'array',
                items: { type: 'string' }
              },
              reasoning: { type: 'string' }
            },
            required: ['kind', 'keepId', 'targetIds', 'reasoning'],
            additionalProperties: false
          }
        }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const plan: Plan = JSON.parse(data.choices[0].message.content);
  
  const validIds = new Set<string>();
  const regex = /#wm-\d+/g;
  let match;
  while ((match = regex.exec(outline)) !== null) {
    validIds.add(match[0].substring(1));
  }

  if (plan.kind === 'isolate') {
    if (plan.keepId && !validIds.has(plan.keepId)) {
      plan.keepId = null;
    }
    plan.targetIds = [];
  } else {
    plan.targetIds = plan.targetIds.filter(id => validIds.has(id));
    plan.keepId = null;
  }

  return plan;
}
