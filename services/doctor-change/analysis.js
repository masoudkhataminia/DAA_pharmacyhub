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

const MAX_DOCTOR_DOCUMENT_BYTES = 15 * 1024 * 1024;
const DOCUMENT_MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf'
};
const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function prepareDoctorDocument(file) {
  if (!file?.buffer?.length) return null;
  if (file.buffer.length > MAX_DOCTOR_DOCUMENT_BYTES) throw Object.assign(new Error('Doctor document must be 15 MB or smaller.'), { status: 413 });
  const filename = String(file.originalname || 'doctor-document').slice(0, 160);
  const extension = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  const declaredMime = String(file.mimetype || '').toLowerCase();
  const imageMime = IMAGE_MIME_TYPES[extension] || (declaredMime.startsWith('image/') ? declaredMime : '');
  const documentMime = DOCUMENT_MIME_TYPES[extension] || (Object.values(DOCUMENT_MIME_TYPES).includes(declaredMime) ? declaredMime : '');
  if (!imageMime && !documentMime) throw Object.assign(new Error('Upload a PDF, Word, RTF, TXT, JPG, PNG or WEBP document.'), { status: 415 });
  return { filename, mime: imageMime || documentMime, kind: imageMime ? 'image' : 'file', buffer: file.buffer };
}

export function doctorChangeAiStatus(env = process.env) {
  return {
    configured: Boolean(env.OPENAI_API_KEY),
    model: env.OPENAI_DOCTOR_CHANGE_MODEL || 'gpt-5-mini',
    maxFileSizeMb: 15,
    acceptedFileTypes: ['PDF','DOC','DOCX','RTF','TXT','JPG','PNG','WEBP']
  };
}

export async function analyseDoctorChange({ patient, medications = [], sourceText = '', file, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured on this server. Add OPENAI_API_KEY to enable document analysis.'), { status: 503 });
  if (!String(sourceText || '').trim() && !file?.buffer?.length) throw Object.assign(new Error('Paste the doctor email or upload a medication summary first.'), { status: 400 });
  const document = prepareDoctorDocument(file);
  const current = medications.map(item => ({ medication: item.medication || item.drugName || '', direction: item.direction || item.directions || '', balance: item.balanceQty ?? null, repeatsLeft: item.repeatsLeft ?? null }));
  const content = [{ type: 'input_text', text: `Current pharmacy medication list for the selected patient (comparison baseline):\n${JSON.stringify(current)}\n\nPasted doctor email / note:\n${String(sourceText || '').slice(0, 30000)}\n\nExtract only medication changes supported by the supplied source. Compare against the baseline. Do not identify the patient, invent a date, dose, day or administration time, or provide treatment advice. If ambiguous use clarify, low confidence, and add a warning. This is a pharmacist-review proposal, never a final clinical instruction.` }];
  if (document) {
    const dataUrl = `data:${document.mime};base64,${document.buffer.toString('base64')}`;
    if (document.kind === 'image') content.push({ type: 'input_image', image_url: dataUrl, detail: 'high' });
    else content.push({ type: 'input_file', filename: document.filename, file_data: dataUrl, ...(document.mime === 'application/pdf' ? { detail: 'high' } : {}) });
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
