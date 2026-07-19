const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'priorityExplanation', 'dataQualityIssues', 'pharmacistChecks', 'warnings'],
  properties: {
    summary: { type: 'string' },
    priorityExplanation: { type: 'string' },
    dataQualityIssues: { type: 'array', items: { type: 'string' } },
    pharmacistChecks: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }
  }
};

const contentText = response => response?.output_text || (response?.output || []).flatMap(item => item?.content || []).find(item => item?.type === 'output_text')?.text || '';

export function smartScriptAiStatus(env = process.env) {
  return { configured: Boolean(env.OPENAI_API_KEY), model: env.OPENAI_SMART_SCRIPT_MODEL || 'gpt-5-mini' };
}

export async function analyseSmartScriptReview({ forecast = {}, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('AI review is not configured on this server. Add OPENAI_API_KEY to enable it.'), { status: 503 });

  const patientForecast = (forecast.patients || [])[0] || null;
  const safeForecast = {
    assumptions: forecast.assumptions || {},
    summary: forecast.summary || {},
    medicinesRequiringReview: (patientForecast?.medicines || []).map(item => ({
      medication: item.medication,
      requestUrgency: item.requestUrgency,
      owing: Boolean(item.owing),
      balanceQty: item.balanceQty,
      weeklyQty: item.weeklyQty,
      repeatsLeft: item.repeatsLeft,
      totalCoverageDays: item.totalCoverageDays,
      shortfallQty: item.shortfallQty,
      neededByDate: item.neededByDate,
      repeatConfidence: item.repeatConfidence,
      source: item.source
    })),
    dataReviewItems: (forecast.reviewItems || []).map(item => ({
      medication: item.medication,
      dataIssue: item.dataIssue || '',
      repeatZeroNeedsCheck: Boolean(item.repeatZeroNeedsCheck),
      repeatConfidence: item.repeatConfidence || '',
      source: item.source || ''
    }))
  };

  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_SMART_SCRIPT_MODEL || 'gpt-5-mini',
      store: false,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: `Review this deterministic pharmacy script forecast for a pharmacist:\n${JSON.stringify(safeForecast)}\n\nThe supplied calculation is the only source of truth. Summarise its priorities and data-quality gaps in plain language. Do not recalculate values, infer missing values, recommend therapy, suggest dose changes, diagnose, or add medicines. Do not treat the result as a clinical instruction. Every action must remain subject to pharmacist verification.`
        }]
      }],
      text: { format: { type: 'json_schema', name: 'smart_script_review', strict: true, schema: REVIEW_SCHEMA } }
    })
  });

  const raw = await response.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw Object.assign(new Error(json?.error?.message || `AI review failed (${response.status})`), { status: response.status >= 500 ? 502 : response.status });
  const output = contentText(json);
  try { return JSON.parse(output); } catch { throw Object.assign(new Error('AI returned an unreadable Smart Script review.'), { status: 502 }); }
}
