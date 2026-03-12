import { isJidGroup, jidNormalizedUser } from '../WABinary/index.js';

export async function resolveJid(conn, m, target) {
    const input =
        target ||
        (m.mentionedJid && m.mentionedJid[0]) ||
        (m.quoted && (m.quoted.sender || m.quoted.participant)) ||
        m.sender ||
        m.jid;

    if (!input) return null;

    if (/@s\.whatsapp\.net$/.test(input)) {
        return jidNormalizedUser(input);
    }

    if (!m.isGroup || !m.chat) {
        if (/^\d+$/.test(input.split('@')[0])) {
            return `${input.split('@')[0]}@s.whatsapp.net`;
        }
        return null;
    }

    let meta;
    try {
        meta = await conn.groupMetadata(m.chat);
    } catch {
        return null;
    }

    if (!meta || !Array.isArray(meta.participants)) return null;

    const inputUser = input.split('@')[0];
    const participant = meta.participants.find(p => {
        if (!p) return false;
        const pJid = p.jid || p.id || '';
        const pLid = p.lid || '';
        return (
            pJid === input ||
            pLid === input ||
            pJid.split('@')[0] === inputUser ||
            pLid.split('@')[0] === inputUser
        );
    });

    if (participant) {
        const resolved = participant.jid || participant.id;
        if (resolved && /@s\.whatsapp\.net$/.test(resolved)) {
            return jidNormalizedUser(resolved);
        }
    }

    return null;
}

export async function resolveJids(conn, m, targets = []) {
    return Promise.all(targets.map(t => resolveJid(conn, m, t)));
}