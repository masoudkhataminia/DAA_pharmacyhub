const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['documentSummary', 'changes', 'warnings'],
  properties: {
    documentSummary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['changeType','medication','oldDirection','newDirection','effectiveDate','days','doseTimes','quantityPerDose','confidence','evidence'],
        properties: {
          changeType: { type: 'string', enum: ['add','stop','dose_change','timing_change','direction_change','temporary','clarify'] },
          medication: { type: 'string' },
          oldDirection: { type: 'string' },
          newDirection: { type: 'string' },
          effectiveDate: { type: 'string', description: 'YYYY-MM-DD when explicitly known, otherwise empty' },
          days: { type: 'array', items: { type: 'string' } },
          doseTimes: { type: 'array', items: { type: 'string' } },
          quantityPerDose: { type: ['number','null'] },
          confidence: { type: 'string', enum: ['high','medium','low'] },
          evidence: { type: 'string' }
        }
      }
    },
    warnings: { type: 'array', items: { type: 'string' } }
  }
};

const contentText = response => response?.output_text || (response?.output || []).flatMap(item => item?.content || []).find(item => item?.type === 'output_text')?.text || '';

export function doctorChangeAiStatus(env = process.env) {
  return { configured: Boolean(env.OPENAI_API_KEY), model: env.OPENAI_DOCTOR_CHANGE_MODEL || 'gpt-5-mini' };
}

export async function analyseDoctorChange({ patient, medications = [], sourceText = '', file, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured on this server. Add OPENAI_API_KEY to enable document analysis.'), { status: 503 });
  if (!String(sourceText || '').trim() && !file?.buffer?.length) throw Object.assign(new Error('Paste the doctor email or upload a medication summary first.'), { status: 400 });
  const current = medications.map(item => ({ medication: item.medication || item.drugName || '', direction: item.direction || item.directions || '', balance: item.balanceQty ?? null, repeatsLeft: item.repeatsLeft ?? null }));
  const content = [{ type: 'input_text', text: `Patient: ${patient?.fullName || 'Selected patient'}\nCurrent pharmacy medication list (comparison baseline):\n${JSON.stringify(current)}\n\nPasted doctor email / note:\n${String(sourceText || '').slice(0, 30000)}\n\nExtract only medication changes supported by the source. Compare against the baseline. Do not invent a date, dose, day or administration time. If ambiguous use clarify, low confidence, and add a warning. This is a pharmacist-review proposal, never a final clinical instruction.` }];
  if (file?.buffer?.length) {
    const mime = String(file.mimetype || 'application/octet-stream');
    const dataUrl = `data:${mime};base64,${file.buffer.toString('base64')}`;
    if (mime.startsWith('image/')) content.push({ type: 'input_image', image_url: dataUrl, detail: 'high' });
    else content.push({ type: 'input_file', filename: String(file.originalname || 'doctor-document').slice(0, 160), file_data: dataUrl });
  }
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_DOCTOR_CHANGE_MODEL || 'gpt-5-mini',
      store: false,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'doctor_medication_change', strict: true, schema: ANALYSIS_SCHEMA } }
    })
  });
  const raw = await response.text();
  let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw Object.assign(new Error(json?.error?.message || `AI analysis failed (${response.status})`), { status: response.status >= 500 ? 502 : response.status });
  const output = contentText(json);
  try { return JSON.parse(output); } catch { throw Object.assign(new Error('AI returned an unreadable medication-change result.'), { status: 502 }); }
}
