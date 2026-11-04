import { parseSignalAddressFromJid } from './shim/protocol.js';
import { resolveBaileysModule } from './shim/baileys-resolve.js';
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const TC_TOKEN_REQUEST_TIMEOUT_MS = 3500;
let cachedBaileysHelpers = null;
async function loadBaileysHelpers() {
    if (cachedBaileysHelpers)
        return cachedBaileysHelpers;
    const mod = await resolveBaileysModule();
    cachedBaileysHelpers = {
        jidDecode: mod.jidDecode,
        jidEncode: mod.jidEncode,
        parseAndInjectE2ESessions: mod.parseAndInjectE2ESessions,
        encodeSignedDeviceIdentity: mod.encodeSignedDeviceIdentity,
        getBinaryNodeChild: mod.getBinaryNodeChild,
        getAllBinaryNodeChildren: mod.getAllBinaryNodeChildren,
        resolveTcTokenJid: mod.resolveTcTokenJid,
        resolveIssuanceJid: mod.resolveIssuanceJid,
        isTcTokenExpired: mod.isTcTokenExpired,
        storeTcTokensFromIqResult: mod.storeTcTokensFromIqResult,
        buildMergedTcTokenIndexWrite: mod.buildMergedTcTokenIndexWrite
    };
    return cachedBaileysHelpers;
}
function addressToJid(address) {
    return address.device
        ? `${address.user}:${address.device}@${address.server}`
        : `${address.user}@${address.server}`;
}
function normalizeDeviceList(baileysHelpers, jids) {
    const { jidDecode, jidEncode } = baileysHelpers;
    const result = new Set();
    for (const jid of jids) {
        const decoded = jidDecode(jid);
        if (!decoded?.user) {
            result.add(jid);
            continue;
        }
        const server = String(jid).endsWith('@lid') ? 'lid' : 's.whatsapp.net';
        result.add(jidEncode(decoded.user, server));
        if (decoded.device != null)
            result.add(`${decoded.user}:${decoded.device}@${server}`);
    }
    return [...result].slice(0, 5);
}
async function resolvePeerLid(sock, target) {
    const raw = String(target || '').trim();
    if (!raw)
        throw new Error('resolvePeerLid: target is required');
    if (raw.endsWith('@lid'))
        return raw;
    const pnJid = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    const lid = await sock.signalRepository.lidMapping?.getLIDForPN(pnJid);
    if (lid)
        return lid;
    return pnJid;
}
async function discoverPeerDevices(sock, baileysHelpers, peerLid) {
    const devices = await sock.getUSyncDevices([peerLid], true, false);
    const jids = devices.map((d) => d.jid).filter(Boolean);
    if (!jids.length)
        return [];
    return normalizeDeviceList(baileysHelpers, jids);
}
async function ensureSignalSessions(sock, baileysHelpers, jids, cache) {
    const missing = [];
    for (const jid of [...new Set(jids.filter(Boolean))]) {
        const signalId = sock.signalRepository.jidToSignalProtocolAddress(jid);
        const cachedAt = cache.get(signalId);
        if (cachedAt && Date.now() - cachedAt < SESSION_CACHE_TTL_MS)
            continue;
        const validation = await sock.signalRepository.validateSession(jid);
        if (validation?.exists) {
            cache.set(signalId, Date.now());
            continue;
        }
        missing.push(jid);
    }
    if (!missing.length)
        return;
    const sessionNode = await sock.query({
        tag: 'iq',
        attrs: { xmlns: 'encrypt', type: 'get', to: 's.whatsapp.net' },
        content: [
            { tag: 'key', attrs: {}, content: missing.map((jid) => ({ tag: 'user', attrs: { jid } })) }
        ]
    });
    await baileysHelpers.parseAndInjectE2ESessions(sessionNode, sock.signalRepository);
    for (const jid of missing) {
        cache.set(sock.signalRepository.jidToSignalProtocolAddress(jid), Date.now());
    }
}
function toBareJid(jid) {
    const at = String(jid).indexOf('@');
    if (at < 0)
        return jid;
    const user = String(jid).slice(0, at).split(':')[0];
    return `${user}@${String(jid).slice(at + 1)}`;
}
const inFlightTcToken = new Map();
async function ensureTcToken(sock, helpers, jid) {
    const keys = sock.authState?.keys;
    if (!keys)
        return undefined;
    const lidMapping = sock.signalRepository?.lidMapping;
    const getLIDForPN = (pn) => lidMapping.getLIDForPN(pn);
    const getPNForLID = (lid) => lidMapping.getPNForLID(lid);
    const bare = toBareJid(jid);
    const storageJid = await helpers.resolveTcTokenJid(bare, getLIDForPN);
    const readEntry = async () => (await keys.get('tctoken', [storageJid]))?.[storageJid];
    const usable = (entry) => !!entry?.token?.length && entry.timestamp !== undefined && !helpers.isTcTokenExpired(entry.timestamp);
    const cached = await readEntry();
    if (usable(cached))
        return Buffer.from(cached.token);
    if (typeof sock.issuePrivacyTokens !== 'function')
        return undefined;
    let pending = inFlightTcToken.get(storageJid);
    if (!pending) {
        pending = (async () => {
            const issueTimestamp = Math.floor(Date.now() / 1000);
            const issueJid = await helpers.resolveIssuanceJid(bare, !!sock.serverProps?.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID);
            const result = await sock.issuePrivacyTokens([issueJid], issueTimestamp);
            await helpers.storeTcTokensFromIqResult({ result, fallbackJid: storageJid, keys, getLIDForPN });
            const current = await readEntry();
            const indexWrite = await helpers.buildMergedTcTokenIndexWrite(keys, [storageJid]);
            await keys.set({
                tctoken: {
                    [storageJid]: { token: Buffer.alloc(0), ...current, senderTimestamp: issueTimestamp },
                    ...indexWrite
                }
            });
            return usable(current) ? Buffer.from(current.token) : undefined;
        })().catch(() => undefined).finally(() => inFlightTcToken.delete(storageJid));
        inFlightTcToken.set(storageJid, pending);
    }
    return Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(undefined), TC_TOKEN_REQUEST_TIMEOUT_MS))
    ]);
}
export async function createVoipDeps(sock) {
    const baileysHelpers = await loadBaileysHelpers();
    const sessionCache = new Map();
    const deps = {
        authClient: {
            getCurrentCredentials() {
                const creds = sock.authState?.creds;
                const account = creds?.account;
                let signedIdentity;
                if (account) {
                    try {
                        signedIdentity = baileysHelpers.encodeSignedDeviceIdentity(account, true);
                    }
                    catch {
                        signedIdentity = undefined;
                    }
                }
                return {
                    meLid: creds?.me?.lid,
                    meJid: creds?.me?.id,
                    signedIdentity
                };
            }
        },
        lowLevelCoordinator: {
            async sendNode(node) {
                await sock.sendNode(node);
            }
        },
        signalDeviceSync: {
            async syncDeviceList(jids) {
                const out = [];
                for (const jid of jids) {
                    try {
                        const peerLid = await resolvePeerLid(sock, jid);
                        const deviceJids = await discoverPeerDevices(sock, baileysHelpers, peerLid);
                        out.push({ deviceJids });
                    }
                    catch {
                        out.push({ deviceJids: [] });
                    }
                }
                return out;
            },
            async queryLidsByPhoneJids(jids) {
                const out = [];
                for (const jid of jids) {
                    try {
                        out.push({ lidJid: await resolvePeerLid(sock, jid) });
                    }
                    catch {
                        out.push({ lidJid: undefined });
                    }
                }
                return out;
            }
        },
        sessionResolver: {
            async ensureSessionsBatch(devices) {
                await ensureSignalSessions(sock, baileysHelpers, devices, sessionCache);
                return devices.map((jid) => ({ address: parseSignalAddressFromJid(jid), session: null }));
            }
        },
        signalProtocol: {
            async encryptMessage(address, plaintext) {
                const jid = addressToJid(address);
                const { type, ciphertext } = await sock.signalRepository.encryptMessage({
                    jid,
                    data: Buffer.from(plaintext)
                });
                return { type, ciphertext: new Uint8Array(ciphertext) };
            },
            async decryptMessage(address, { type, ciphertext }) {
                const jid = addressToJid(address);
                const decrypted = await sock.signalRepository.decryptMessage({ jid, type, ciphertext });
                return new Uint8Array(decrypted);
            }
        },
        messageDispatch: {
            async syncSignalSession(jid) {
                await ensureSignalSessions(sock, baileysHelpers, [jid], sessionCache);
            }
        }
    };
    const stores = {
        privacyToken: {
            async getByJid(jid) {
                const token = await ensureTcToken(sock, baileysHelpers, jid);
                return token?.length ? { tcToken: token } : undefined;
            }
        }
    };
    return { deps, stores };
}
