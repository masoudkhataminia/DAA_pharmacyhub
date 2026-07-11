export class MyPakError extends Error {
  constructor(message, { status = 502, code = 'MYPAK_ERROR', temporary = false } = {}) {
    super(message);
    this.name = 'MyPakError';
    this.status = status;
    this.code = code;
    this.temporary = temporary;
  }
}

export function publicMyPakError(error) {
  if (error?.status === 401 || error?.status === 403) return { status: error.status, error: 'MyPak authentication failed' };
  if (error?.status === 429) return { status: 429, error: 'MyPak rate limit reached; try again later' };
  return { status: error?.status >= 400 && error?.status < 500 ? error.status : 502, error: error?.message || 'MyPak request failed' };
}
