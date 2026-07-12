export const MYPAK_ENDPOINTS = Object.freeze({
  patientList: { method: 'POST', path: '/patients/list' },
  virtualPillBalances: { method: 'POST', path: '/vpbbalances/list' },
  patientReportOptions: { method: 'GET', path: '/patientreportoption' },
  patientGroup: { method: 'GET', path: '/patientGroups/:groupId' }
});

export function endpointPath(name, params = {}) {
  const endpoint = MYPAK_ENDPOINTS[name];
  if (!endpoint) throw new Error(`Unknown MyPak endpoint: ${name}`);
  return endpoint.path.replace(/:([A-Za-z]+)/g, (_, key) => {
    const value = String(params[key] ?? '');
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid MyPak endpoint parameter: ${key}`);
    return encodeURIComponent(value);
  });
}
