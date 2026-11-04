import { getBinaryNodeChild, isLidUser, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { makeCommunitiesSocket } from './communities.js';
export const makeUsernameSocket = (config) => {
    const sock = makeCommunitiesSocket(config);
    const { query, generateMessageTag } = sock;
    const lookupUsername = async (input, { pin, debug = false } = {}) => {
        const username = String(input).trim().replace(/^@/, '').toLowerCase();
        if (!username)
            throw new Error('username is empty');
        const iq = {
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
            content: [
                {
                    tag: 'usync',
                    attrs: {
                        context: 'interactive',
                        mode: 'query',
                        sid: generateMessageTag(),
                        last: 'true',
                        index: '0'
                    },
                    content: [
                        {
                            tag: 'query',
                            attrs: {},
                            content: [
                                { tag: 'contact', attrs: { addressing_mode: 'lid' } },
                                { tag: 'lid', attrs: {} },
                                { tag: 'username', attrs: {} },
                                { tag: 'business', attrs: {}, content: [{ tag: 'verified_name', attrs: {} }] }
                            ]
                        },
                        {
                            tag: 'list',
                            attrs: {},
                            content: [
                                {
                                    tag: 'user',
                                    attrs: {},
                                    content: [{ tag: 'contact', attrs: { username, ...(pin ? { pin } : {}) } }]
                                }
                            ]
                        }
                    ]
                }
            ]
        };
        const res = await query(iq);
        const userNode = getBinaryNodeChild(getBinaryNodeChild(getBinaryNodeChild(res, 'usync'), 'list'), 'user');
        if (!userNode)
            return null;
        const contactNode = getBinaryNodeChild(userNode, 'contact');
        const lidNode = getBinaryNodeChild(userNode, 'lid');
        const usernameNode = getBinaryNodeChild(userNode, 'username');
        const businessNode = getBinaryNodeChild(userNode, 'business');
        const jid = userNode.attrs.jid ? jidNormalizedUser(userNode.attrs.jid) : undefined;
        const lid = lidNode?.attrs?.val || (jid && isLidUser(jid) ? jid : undefined);
        let pn = userNode.attrs.pn_jid ||
            contactNode?.attrs?.pn_jid ||
            businessNode?.attrs?.pn_jid ||
            (jid && !isLidUser(jid) ? jid : undefined);
        if (!pn && lid) {
            try {
                const mapped = await sock.signalRepository.lidMapping.getPNForLID(lid);
                if (mapped)
                    pn = mapped;
            }
            catch { }
        }
        const toText = (c) => Buffer.isBuffer(c) || c instanceof Uint8Array
            ? Buffer.from(c).toString('utf-8')
            : typeof c === 'string'
                ? c
                : undefined;
        return {
            exists: contactNode?.attrs?.type === 'in',
            username: toText(usernameNode?.content) || username,
            lid: lid ? jidNormalizedUser(lid) : null,
            pn: pn ? jidNormalizedUser(pn) : null,
            pnNumber: pn ? jidNormalizedUser(pn).split('@')[0] : null,
            isBusiness: Boolean(businessNode),
            jid,
            raw: debug ? userNode : undefined
        };
    };
    return {
        ...sock,
        lookupUsername
    };
};
