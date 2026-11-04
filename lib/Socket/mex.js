import { Boom } from '../Addon/index.js';
import { QueryIds } from '../Types/index.js';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary/index.js';
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: S_WHATSAPP_NET,
            xmlns: 'w:mex'
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
            }
        ]
    });
};
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    if (child?.content) {
        const data = JSON.parse(child.content.toString());
        if (data.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map((err) => err.message || 'Unknown error').join(', ');
            const firstError = data.errors[0];
            const errorCode = firstError.extensions?.error_code || 400;
            throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError });
        }
        const response = dataPath ? data?.data?.[dataPath] : data?.data;
        if (typeof response !== 'undefined') {
            return response;
        }
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ');
    throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result });
};

export const executeWMexQueryIgnoreResponse = async (variables, queryId, query, generateMessageTag) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    if (!child?.content) {
        return;
    }
    let data;
    try {
        data = JSON.parse(child.content.toString());
    }
    catch {
        return;
    }
    if (Array.isArray(data.errors) && data.errors.length > 0) {
        const errorMessages = data.errors.map((err) => err.message || 'Unknown error').join(', ');
        const firstError = data.errors[0];
        const errorCode = firstError.extensions?.error_code || 400;
        throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError });
    }
};
export const NEWSLETTER_ID_ALTERNATES = Object.freeze({
    METADATA: { alternates: ['27456920720571478'], readOnly: true, extraVariables: { fetch_pinned_messages: false, fetch_status_metadata: false, fetch_wamo_sub: false } },
    SUBSCRIBED: { alternates: ['25399611239711790'], readOnly: true },
    ADMIN_COUNT: { alternates: ['26278439461859188'], readOnly: true },
    CREATE: { alternates: ['25149874324715067'], readOnly: false },
    CHANGE_OWNER: { alternates: ['9546742745432473'], readOnly: false },
    DEMOTE: { alternates: ['9880997548630971'], readOnly: false },
    FOLLOW: { alternates: ['7871414976211147'], readOnly: false },
    UNFOLLOW: { alternates: ['7238632346214362'], readOnly: false }
});
const STALE_QUERY_RE = /persisted|not[ _-]?found|unknown (query|doc|operation)|doc[_ -]?id|invalid (query|document|operation)|no such (query|operation)|unsupported (query|operation)|deprecated/i;
const AUTH_CODES = new Set([401, 403, 419]);
const errorText = (e) => [e?.message, e?.data?.message, e?.data?.extensions?.error_code, e?.data?.extensions?.severity, JSON.stringify(e?.data?.attrs ?? '')].filter(Boolean).join(' ');
export const isStaleQueryError = (e) => STALE_QUERY_RE.test(errorText(e));
export const makeMexWithFallback = ({ query, generateMessageTag, logger, overrides = {} }) => {
    const nameById = new Map(Object.entries(QueryIds).map(([name, id]) => [String(id), name]));
    const preferred = new Map();
    const raw = (variables, id, path) => executeWMexQuery(variables, id, path, query, generateMessageTag);
    const candidatesFor = (id) => {
        const name = nameById.get(String(id));
        const spec = name ? NEWSLETTER_ID_ALTERNATES[name] : undefined;
        const list = [];
        if (name && overrides[name])
            list.push(String(overrides[name]));
        if (preferred.has(String(id)))
            list.push(preferred.get(String(id)));
        list.push(String(id));
        if (spec)
            list.push(...spec.alternates);
        return { name, spec, list: [...new Set(list)] };
    };
    const executeWithFallback = async (variables, queryId, dataPath) => {
        const { name, spec, list } = candidatesFor(queryId);
        if (list.length === 1)
            return raw(variables, list[0], dataPath);
        let firstError;
        for (let i = 0; i < list.length; i++) {
            const id = list[i];
            const vars = spec?.extraVariables && id !== String(queryId) ? { ...spec.extraVariables, ...variables } : variables;
            try {
                const res = await raw(vars, id, dataPath);
                if (id !== String(queryId) && preferred.get(String(queryId)) !== id) {
                    preferred.set(String(queryId), id);
                    logger?.info?.({ op: name, primary: queryId, using: id }, 'newsletter mex: primary doc id failed, alternate id worked (remembered for this process)');
                }
                return res;
            }
            catch (e) {
                firstError ??= e;
                const status = e?.output?.statusCode ?? e?.data?.statusCode;
                const retry = i < list.length - 1 && !AUTH_CODES.has(status) && (spec?.readOnly || isStaleQueryError(e));
                if (!retry)
                    throw firstError;
                logger?.debug?.({ op: name, id, err: e?.message }, 'newsletter mex: trying next candidate doc id');
            }
        }
        throw firstError;
    };
    return { executeWMexQuery: executeWithFallback, preferred };
};
