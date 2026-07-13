export const MYPAK_ENDPOINTS = Object.freeze({
  patientList: { method: 'POST', path: '/patients/list' },
  virtualPillBalances: { method: 'POST', path: '/vpbbalances/list' },
  quickDispense: { method: 'POST', path: '/quickdispense/search' },
  insufficientPillBalances: { method: 'POST', path: '/quickdispense/insufficient-pill-balance' },
  doctors: { method: 'GET', path: '/doctors' },
  patientDetail: { method: 'GET', path: '/patients/:patientId' },
  dispenseTracking: { method: 'POST', path: '/scripttrackings/search' },
  patientReportOptions: { method: 'GET', path: '/patientreportoption' },
  patientGroup: { method: 'GET', path: '/patientGroups/:groupId' },
  packJobs: { method: 'POST', path: '/packjobs' },
  packJobSummary: { method: 'POST', path: '/packjobs/summary' },
  packJobChecking: { method: 'GET', path: '/packjobs/:jobId/checking' },
  packJobDistribution: { method: 'GET', path: '/packjobs/:jobId/distribution' },
  packJobCorrection: { method: 'GET', path: '/packjobs/:jobId/correction' },
  packJobPdf: { method: 'POST', path: '/packjobs/pdf' }
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
