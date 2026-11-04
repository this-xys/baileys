export const normalizePairingCode = value => {
    const normalized = String(value ?? '')
        .trim()
        .toUpperCase();
    return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : '';
};

export const formatPairingCode = code => {
    const c = String(code ?? '');
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export const pairingErrorCode = error => {
    const fromData = typeof error?.data === 'number' ? error.data : void 0;
    const status = error?.output?.statusCode ?? error?.statusCode ?? error?.status;
    return fromData ?? (status && status !== 500 ? status : void 0);
};

export const isRateLimitError = error => {
    const code = pairingErrorCode(error);
    return code === 428 || code === 429 || /rate[- ]?overlimit|rate.?limit|too many/i.test(String(error?.message || error));
};

export const isCustomPairingError = error => {
    const code = pairingErrorCode(error);
    return code === 422 || /custom pairing code|pairing code.*(invalid|reject|unsupported)|invalid.*pairing/i.test(String(error?.message || error));
};

const SUPPORTED_PASSKEY_TYPES = new Set(['passkey_prologue_request', 'crsc_continuation']);

export const getPasskeyRequestState = node => {
    const type = node?.attrs?.type;
    if (!SUPPORTED_PASSKEY_TYPES.has(type)) return undefined;
    const content = Array.isArray(node?.content) ? node.content : [];
    const hasOptions = content.some(item => item && typeof item === 'object' && 'tag' in item);
    return { type, hasOptions };
};
