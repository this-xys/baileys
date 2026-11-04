import { proto } from '../../WAProto/index.js';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQueryIgnoreResponse as genericExecuteWMexQueryIgnoreResponse, makeMexWithFallback } from './mex.js';
const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture?.id,
            directPath: thread.picture?.direct_path
        },
        mute_state: viewer.mute
    };
};
const parseNewsletterMetadata = (result) => {
    if (typeof result !== 'object' || result === null) {
        return null;
    }
    if ('id' in result && typeof result.id === 'string') {
        return result;
    }
    if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
        return result.result;
    }
    return null;
};
export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { ev, query, generateMessageTag } = sock;
    const { logger, newsletterMetadataCacheTtlMs, newsletterMetadataCacheMaxSize } = config;
    const { executeWMexQuery } = makeMexWithFallback({
        query,
        generateMessageTag,
        logger,
        overrides: config?.newsletterQueryIds
    });
    const executeWMexQueryIgnoreResponse = (variables, queryId) => {
        return genericExecuteWMexQueryIgnoreResponse(variables, queryId, query, generateMessageTag);
    };
    const newsletterMetaCache = new Map();
    const inviteToNewsletterJidCache = new Map();
    const inFlightNewsletterMeta = new Map();
    const cacheTtl = newsletterMetadataCacheTtlMs ?? 0;
    const cacheMaxSize = Math.max(16, newsletterMetadataCacheMaxSize || 256);
    const pruneCache = (cache) => {
        if (cache.size <= cacheMaxSize) {
            return;
        }
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
            cache.delete(oldestKey);
        }
    };
    const getFromMetaCache = (jid) => {
        if (cacheTtl <= 0) {
            return undefined;
        }
        const entry = newsletterMetaCache.get(jid);
        if (entry && Date.now() - entry.ts < cacheTtl) {
            return entry.data;
        }
        return undefined;
    };
    const setMetaCache = (jid, data) => {
        if (cacheTtl <= 0) {
            return;
        }
        newsletterMetaCache.set(jid, { data, ts: Date.now() });
        pruneCache(newsletterMetaCache);
    };
    const mergeNewsletterSettingsUpdate = (jid, update) => {
        if (cacheTtl <= 0 || !update || typeof update !== 'object') {
            return;
        }
        const existing = newsletterMetaCache.get(jid);
        if (!existing) {
            return;
        }
        const next = { ...existing.data };
        if (typeof update.name === 'string') {
            next.name = update.name;
        }
        if (typeof update.description === 'string') {
            next.description = update.description;
        }
        newsletterMetaCache.set(jid, { data: next, ts: existing.ts });
    };
    ev.on('newsletter-settings.update', ({ id, update }) => {
        mergeNewsletterSettingsUpdate(id, update);
    });
    const newsletterUpdate = async (jid, updates) => {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null
            }
        };
        const result = await executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
        newsletterMetaCache.delete(jid);
        return result;
    };
    const getNewsletterMetadata = async (type, key, viewRole) => {
        if (type === 'jid') {
            const cached = getFromMetaCache(key);
            if (cached) {
                return cached;
            }
        }
        else {
            const mapped = inviteToNewsletterJidCache.get(key);
            if (mapped && (cacheTtl <= 0 || Date.now() - mapped.ts < cacheTtl)) {
                const cached = getFromMetaCache(mapped.jid);
                if (cached) {
                    return cached;
                }
            }
        }
        const inflightKey = `${type}:${key}:${viewRole || ''}`;
        const inflight = inFlightNewsletterMeta.get(inflightKey);
        if (inflight) {
            return inflight;
        }
        const pending = (async () => {
            const variables = {
                fetch_creation_time: true,
                fetch_full_image: true,
                fetch_viewer_metadata: true,
                input: {
                    key,
                    type: type.toUpperCase()
                }
            };
            if (viewRole) {
                variables.input.view_role = viewRole;
            }
            const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
            const parsed = parseNewsletterMetadata(result);
            if (parsed?.id) {
                setMetaCache(parsed.id, parsed);
                if (type === 'invite') {
                    inviteToNewsletterJidCache.set(key, { jid: parsed.id, ts: Date.now() });
                    pruneCache(inviteToNewsletterJidCache);
                }
            }
            return parsed;
        })();
        inFlightNewsletterMeta.set(inflightKey, pending);
        try {
            return await pending;
        }
        finally {
            inFlightNewsletterMeta.delete(inflightKey);
        }
    };
    const isFollowingNewsletter = async (jid) => {
        try {
            const result = await getNewsletterMetadata('jid', jid, 'GUEST');
            return result?.viewer_metadata?.mute === 'OFF' || result?.viewer_metadata?.is_subscribed === true;
        }
        catch {
            return false;
        }
    };
    return {
        ...sock,
        executeWMexQuery,
        isFollowingNewsletter,
        newsletterCreate: async (name, description) => {
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        newsletterSubscribed: async () => {
            return executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
        },
        newsletterMetadata: getNewsletterMetadata,
        newsletterFollow: async (jid) => {
            const result = await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW);
            newsletterMetaCache.delete(jid);
            return result;
        },
        newsletterUnfollow: async (jid) => {
            const result = await executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW);
            newsletterMetaCache.delete(jid);
            return result;
        },
        newsletterMute: async (jid) => {
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.MUTE);
            newsletterMetaCache.delete(jid);
        },
        newsletterUnmute: async (jid) => {
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.UNMUTE);
            newsletterMetaCache.delete(jid);
        },
        newsletterUpdateName: async (jid, name) => {
            return await newsletterUpdate(jid, { name });
        },
        newsletterUpdateDescription: async (jid, description) => {
            return await newsletterUpdate(jid, { description });
        },
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return await newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async (jid) => {
            return await newsletterUpdate(jid, { picture: '' });
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: reaction ? { code: reaction } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (type, key, count, after, before) => {
            const messagesAttrs = {
                count: count.toString(),
                type,
                [type === 'jid' ? 'jid' : 'key']: key
            };
            if (after) {
                messagesAttrs.after = after.toString();
            }
            if (before) {
                messagesAttrs.before = before.toString();
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    xmlns: 'newsletter',
                    to: S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'messages',
                        attrs: messagesAttrs
                    }
                ]
            });
            const messagesNode = getBinaryNodeChild(result, 'messages');
            if (!messagesNode) {
                return [];
            }
            const newsletterJid = messagesNode.attrs.jid || (type === 'jid' ? key : undefined);
            const messages = [];
            for (const child of getBinaryNodeChildren(messagesNode, 'message')) {
                const plaintextNode = getBinaryNodeChild(child, 'plaintext');
                if (!plaintextNode?.content) {
                    continue;
                }
                try {
                    const contentBuf = typeof plaintextNode.content === 'string'
                        ? Buffer.from(plaintextNode.content, 'binary')
                        : Buffer.from(plaintextNode.content);
                    const messageProto = proto.Message.decode(contentBuf).toJSON();
                    const fullMessage = proto.WebMessageInfo.fromObject({
                        key: {
                            remoteJid: newsletterJid,
                            id: child.attrs.id || child.attrs.server_id,
                            server_id: child.attrs.server_id,
                            fromMe: false
                        },
                        message: messageProto,
                        messageTimestamp: child.attrs.t ? +child.attrs.t : undefined
                    }).toJSON();
                    messages.push(fullMessage);
                }
                catch (error) {
                    logger.error({ error }, 'Failed to decode newsletter message');
                }
            }
            return messages;
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
            const duration = liveUpdatesNode?.attrs?.duration;
            return duration ? { duration: duration } : null;
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return response.admin_count;
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
        }
    };
};
const autoFollowSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const autoFollowSockets = new WeakSet();
const autoFollowTasks = new WeakMap();
const autoFollowCompleted = new WeakSet();
const resolveAutoFollowJid = async (sock, config = {}) => {
    const candidate = (config.autoFollowNewsletterJid || '').trim();
    if (!candidate) {
        return null;
    }
    if (candidate.endsWith('@newsletter')) {
        return candidate;
    }
    if (/^\d+$/.test(candidate)) {
        return `${candidate}@newsletter`;
    }
    if (candidate.includes('whatsapp.com/channel/') || candidate.includes('wa.me/channel/')) {
        try {
            const metadata = await sock.newsletterMetadata?.('invite', candidate);
            return metadata?.id || null;
        }
        catch {
            return null;
        }
    }
    return null;
};
const runAutoFollow = async (sock, config = {}) => {
    if (!sock?.query || !sock?.generateMessageTag) {
        return false;
    }
    if (autoFollowCompleted.has(sock)) {
        return true;
    }
    const existingTask = autoFollowTasks.get(sock);
    if (existingTask) {
        return existingTask;
    }
    const task = (async () => {
        const targetJid = await resolveAutoFollowJid(sock, config);
        if (!targetJid) {
            return false;
        }
        try {
            if (typeof sock.isFollowingNewsletter === 'function' && (await sock.isFollowingNewsletter(targetJid))) {
                autoFollowCompleted.add(sock);
                return true;
            }
        }
        catch { }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await sock.newsletterFollow(targetJid);
                autoFollowCompleted.add(sock);
                return true;
            }
            catch {
                if (attempt === 2) {
                    return false;
                }
                await autoFollowSleep(4000 * (attempt + 1));
            }
        }
        return false;
    })();
    autoFollowTasks.set(sock, task);
    try {
        await task;
    }
    finally {
        autoFollowTasks.delete(sock);
    }
};
export const triggerAutoFollow = (sock, config = {}) => {
    if (!config.autoFollowNewsletterJid || config.autoFollowNewsletterOnConnect === false) {
        return;
    }
    if (autoFollowSockets.has(sock)) {
        return;
    }
    autoFollowSockets.add(sock);
    const delayMs = Number.isFinite(config.autoFollowNewsletterDelayMs)
        ? Math.max(0, config.autoFollowNewsletterDelayMs)
        : 90000;
    if (sock?.ev?.on) {
        const onConnectionUpdate = async (update) => {
            if (update?.connection !== 'open' || autoFollowCompleted.has(sock)) {
                return;
            }
            sock.ev.off?.('connection.update', onConnectionUpdate);
            await autoFollowSleep(delayMs);
            await runAutoFollow(sock, config);
        };
        sock.ev.on('connection.update', onConnectionUpdate);
    }
};
