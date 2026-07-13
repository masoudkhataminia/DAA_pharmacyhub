export class MpsError extends Error {
  constructor(message, { status = 502, code = 'MPS_ERROR', temporary = false } = {}) {
    super(message);
    this.name = 'MpsError';
    this.status = status;
    this.code = code;
    this.temporary = temporary;
  }
}

export function publicMpsError(error) {
  if (error?.status === 401 || error?.status === 403) {
    return { status: error.status, error: 'MPS authentication failed or this account cannot access the requested facility' };
  }
  if (error?.status === 429) return { status: 429, error: 'MPS rate limit reached; try again later' };
  const status = error?.status >= 400 && error?.status < 500 ? error.status : 502;
  return { status, error: error?.message || 'MPS request failed' };
}
