import { QueryIds, XWAPaths } from '../Types/index.js';
import { decryptMessageNode } from '../Utils/decode-wa-message.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isJidNewsletter, S_WHATSAPP_NET } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery as genericExecuteWMexQuery, executeWMexQueryIgnoreResponse as genericExecuteWMexQueryIgnoreResponse } from './mex.js';

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
            id: thread.picture.id,
            directPath: thread.picture.direct_path
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
    const { authState, ev, query, generateMessageTag, signalRepository } = sock;
    const { logger, newsletterMetadataCacheTtlMs, newsletterMetadataCacheMaxSize } = config;
    const executeWMexQuery = (variables, queryId, dataPath) => {
        return genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    };
    const executeWMexQueryIgnoreResponse = (variables, queryId) => {
        return genericExecuteWMexQueryIgnoreResponse(variables, queryId, query, generateMessageTag);
    };
    let newsletterMetaCache;
    let inviteToNewsletterJidCache;
    const inFlightNewsletterMeta = new Map();
    const initCache = async () => {
        if (newsletterMetadataCacheTtlMs > 0) {
            try {
                const { LRUCache } = await import('lru-cache');
                newsletterMetaCache = new LRUCache({
                    max: Math.max(16, newsletterMetadataCacheMaxSize || 0),
                    ttl: newsletterMetadataCacheTtlMs,
                    updateAgeOnGet: true
                });
                inviteToNewsletterJidCache = new LRUCache({
                    max: Math.max(16, Math.min(512, newsletterMetadataCacheMaxSize || 0)),
                    ttl: newsletterMetadataCacheTtlMs,
                    updateAgeOnGet: true
                });
            } catch {
            }
        }
    };
    initCache();

    const mergeNewsletterSettingsUpdate = (jid, update) => {
        if (!newsletterMetaCache || !update || typeof update !== 'object') return;
        const existing = newsletterMetaCache.get(jid);
        if (!existing) return;
        const next = { ...existing };
        if (typeof update.name === 'string') next.name = update.name;
        if (typeof update.description === 'string') next.description = update.description;
        newsletterMetaCache.set(jid, next);
    };
    ev.on('newsletter-settings.update', ({ id, update }) => {
        mergeNewsletterSettingsUpdate(id, update);
    });
    const newsletterQuery = (jid, type, content) =>
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'newsletter',
                to: jid
            },
            content
        });

    const newsletterUpdate = async (jid, updates) => {
        const { settings, ...rest } = updates;
        const variables = {
            newsletter_id: jid,
            updates: {
                ...rest,
                settings: typeof settings === 'undefined' ? null : settings
            }
        };
        return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    };
    const parseFetchedMessages = async (node, mode, { decrypt }) => {
        const messagesNode = mode === 'messages' ? getBinaryNodeChild(node, 'messages') : getBinaryNodeChild(getBinaryNodeChild(node, 'message_updates'), 'messages');
        if (!messagesNode) return [];
        const fromJid = messagesNode.attrs.jid;
        return await Promise.all(getAllBinaryNodeChildren(messagesNode).map(async (messageNode) => {
                if (fromJid && !messageNode.attrs.from) {
                    messageNode.attrs.from = fromJid;
                }
                const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0', 10);
                const reactionNode = getBinaryNodeChild(messageNode, 'reactions');
                const reactions = getBinaryNodeChildren(reactionNode, 'reaction').map(({ attrs }) => ({
                    count: parseInt(attrs.count || '0', 10),
                    code: attrs.code || ''
                }));

                const server_id =
                    messageNode.attrs.server_id ||
                    messageNode.attrs.message_id ||
                    messageNode.attrs.id ||
                    '';

                const data = { server_id, views, reactions };

                if (decrypt) {
                    const meId = authState.creds.me.id;
                    const meLid = authState.creds.me.lid || '';
                    const { fullMessage, decrypt: doDecrypt } = decryptMessageNode(
                        messageNode,
                        meId,
                        meLid,
                        signalRepository,
                        logger
                    );
                    await doDecrypt();
                    data.message = fullMessage;
                }

                return data;
            })
        );
    };

    const getNewsletterMetadata = async (type, key, viewRole) => {
        if (type === 'jid') {
            const cached = newsletterMetaCache?.get(key);
            if (cached) return cached;
        } else {
            const mapped = inviteToNewsletterJidCache?.get(key);
            if (mapped) {
                const cached = newsletterMetaCache?.get(mapped);
                if (cached) return cached;
            }
        }

        const inflightKey = `${type}:${key}:${viewRole || ''}`;
        const inflight = inFlightNewsletterMeta.get(inflightKey);
        if (inflight) return inflight;

        const p = (async () => {
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
                newsletterMetaCache?.set(parsed.id, parsed);
                if (type === 'invite') {
                    inviteToNewsletterJidCache?.set(key, parsed.id);
                }
            }

            return parsed;
        })();

        inFlightNewsletterMeta.set(inflightKey, p);
        try {
            return await p;
        } finally {
            inFlightNewsletterMeta.delete(inflightKey);
        }
    };

    const newsletterFetchMessages = async (...args) => {
        if (args[0] === 'invite' || args[0] === 'jid') {
            const [type, key, count, after] = args;
            const attrs = { type, count: count.toString() };
            if (type === 'invite') {
                attrs.key = key;
            } else {
                attrs.jid = key;
            }
            if (typeof after === 'number') {
                attrs.after = after.toString();
            }
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [{ tag: 'messages', attrs }]);
            return await parseFetchedMessages(result, 'messages', { decrypt: true });
        }
        const [jid, count, since, after] = args;
        const messageUpdateAttrs = { count: count.toString() };
        if (typeof since === 'number') messageUpdateAttrs.since = since.toString();
        if (typeof after === 'number') messageUpdateAttrs.after = after.toString();
        return query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'newsletter',
                to: jid
            },
            content: [{ tag: 'message_updates', attrs: messageUpdateAttrs }]
        });
    };

    return {
        ...sock,
        newsletterQuery,
        newsletterCreate: async (name, description, picture) => {
            try {
                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        xmlns: 'tos',
                        id: generateMessageTag(),
                        type: 'set'
                    },
                    content: [
                        {
                            tag: 'notice',
                            attrs: { id: '20601218', stage: '5' },
                            content: []
                        }
                    ]
                });
            } catch {
            }
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            if (picture) {
                const { img } = await generateProfilePicture(picture);
                variables.input.picture = img.toString('base64');
            }
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        newsletterMetadata: getNewsletterMetadata,
        newsletterFetchAllParticipating: async (viewRole) => {
            const list = await executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
            const items = Array.isArray(list) ? list : [];
            const data = {};
            const concurrency = 3;
            let i = 0;
            const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
                while (i < items.length) {
                    const item = items[i++];
                    const jid = item?.id;
                    if (!jid || !isJidNewsletter(jid)) continue;
                    const meta = await getNewsletterMetadata('jid', jid, viewRole);
                    if (meta) data[meta.id] = meta;
                }
            });
            await Promise.all(workers);
            return data;
        },
        newsletterFollow: (jid) => {
            return executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.FOLLOW);
        },
        newsletterUnfollow: (jid) => {
            return executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.UNFOLLOW);
        },
        newsletterMute: (jid) => {
            return executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.MUTE);
        },
        newsletterUnmute: (jid) => {
            return executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.UNMUTE);
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
        newsletterReactionMode: async (jid, mode) => {
            return await newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } });
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
        newsletterFetchMessages,
        newsletterFetchUpdates: async (jid, count, { since, after, decrypt } = {}) => {
            const attrs = { count: count.toString() };
            if (typeof since === 'number') attrs.since = since.toString();
            if (typeof after === 'number') attrs.after = after.toString();
            const result = await newsletterQuery(jid, 'get', [{ tag: 'message_updates', attrs }]);
            return await parseFetchedMessages(result, 'updates', { decrypt: !!decrypt });
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
            const response = await executeWMexQuery(
                { newsletter_id: jid },
                QueryIds.ADMIN_COUNT,
                XWAPaths.xwa2_newsletter_admin_count
            );
            return response.admin_count;
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER);
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE);
        },
        newsletterDelete: async (jid) => {
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, QueryIds.DELETE);
        },
        newsletterAction: async (jid, type) => {
            const queryId = QueryIds[type.toUpperCase()];
            if (!queryId) throw new Error(`Unknown newsletter action: ${type}`);
            await executeWMexQueryIgnoreResponse({ newsletter_id: jid }, queryId);
        }
    };
};

export const extractNewsletterMetadata = (node, isCreate) => {
    const result = getBinaryNodeChild(node, 'result')?.content?.toString();
    const metadataPath = JSON.parse(result).data[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.NEWSLETTER];
    const getUrlFromDirectPath = (directPath) =>
        directPath ? `https://mmg.whatsapp.net${directPath}` : '';
    return {
        id: metadataPath?.id,
        state: metadataPath?.state?.type,
        creation_time: +metadataPath?.thread_metadata?.creation_time,
        name: metadataPath?.thread_metadata?.name?.text,
        nameTime: +metadataPath?.thread_metadata?.name?.update_time,
        description: metadataPath?.thread_metadata?.description?.text,
        descriptionTime: +metadataPath?.thread_metadata?.description?.update_time,
        invite: metadataPath?.thread_metadata?.invite,
        handle: metadataPath?.thread_metadata?.handle,
        picture: getUrlFromDirectPath(metadataPath?.thread_metadata?.picture?.direct_path || ''),
        preview: getUrlFromDirectPath(metadataPath?.thread_metadata?.preview?.direct_path || ''),
        reaction_codes: metadataPath?.thread_metadata?.settings?.reaction_codes?.value,
        subscribers: +metadataPath?.thread_metadata?.subscribers_count,
        verification: metadataPath?.thread_metadata?.verification,
        viewer_metadata: metadataPath?.viewer_metadata
    };
};
