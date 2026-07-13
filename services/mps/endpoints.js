export const MPS_ENDPOINTS = Object.freeze({
  health: { method: 'GET', path: '/health', auth: false, response: 'text', query: [] },
  currentUser: { method: 'GET', path: '/users/hs-user/current', query: [] },
  facilityGroups: { method: 'GET', path: '/facility-groups', query: [] },
  facilities: { method: 'GET', path: '/facilities', query: [] },
  facilityGroupConfiguration: { method: 'GET', path: '/facility-groups/configuration/:facilityGroupId', query: [] },
  patients: { method: 'GET', path: '/patients/list', query: ['facilityGroupId', 'changeNumber', 'pageSize'] },
  patientMhr: { method: 'GET', path: '/patients/:facilityGroupId/:patientId/mhr', query: [] },
  patientMovements: { method: 'GET', path: '/patient-movements/list', query: ['facilityGroupId', 'changeNumber', 'pageSize'] },
  medicationChart: { method: 'GET', path: '/medication-chart', query: ['patientId'] },
  drugs: { method: 'GET', path: '/drugs', query: ['changeNumber', 'pageSize'] },
  drugForms: { method: 'GET', path: '/drug-forms', query: ['changeNumber', 'pageSize'] },
  drugCategories: { method: 'GET', path: '/drug-categories', query: ['etag'] },
  orders: { method: 'GET', path: '/orders', query: ['facilityGroupId', 'changeNumber', 'pageSize'] },
  packedDays: { method: 'GET', path: '/packed-day/list', query: ['sinceChangeNumber', 'facilityGroupId', 'pageSize', 'maxChangeNumber', 'startDate', 'endDate'] },
  packedPrn: { method: 'GET', path: '/packed-prn/list', query: ['sinceChangeNumber', 'facilityGroupId', 'pageSize'] },
  medicationChangesReport: { method: 'GET', path: '/facility-medication-changes-report', query: ['facilityGroupId', 'startDateMonth'] }
});

function encodePathValue(value, key) {
  const stringValue = String(value ?? '').trim();
  if (!stringValue || !/^[A-Za-z0-9_-]+$/.test(stringValue)) throw new Error(`Invalid MPS endpoint parameter: ${key}`);
  return encodeURIComponent(stringValue);
}

export function endpointUrl(name, { params = {}, query = {} } = {}) {
  const endpoint = MPS_ENDPOINTS[name];
  if (!endpoint) throw new Error(`Unknown MPS endpoint: ${name}`);
  const path = endpoint.path.replace(/:([A-Za-z]+)/g, (_, key) => encodePathValue(params[key], key));
  const allowed = new Set(endpoint.query || []);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) throw new Error(`Unsupported MPS query parameter for ${name}: ${key}`);
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') throw new Error(`Invalid MPS query parameter: ${key}`);
    search.set(key, value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}
