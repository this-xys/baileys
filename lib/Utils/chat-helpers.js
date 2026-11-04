import { Boom } from '../Addon/index.js';
import { jidDecode } from '../WABinary/index.js';
export const getPhoneNumber = async (sock, jid) => {
    if (typeof jid !== 'string' || !jid.includes('@')) {
        throw new Boom('getPhoneNumber(jid) requires a JID string', { statusCode: 400 });
    }
    let decoded;
    try {
        decoded = jidDecode(jid);
    }
    catch {
        throw new Boom(`getPhoneNumber: invalid JID ${jid}`, { statusCode: 400 });
    }
    const { user, server } = decoded;
    if (server === 's.whatsapp.net') {
        return user;
    }
    if (server === 'lid') {
        const store = sock?.signalRepository?.lidMapping;
        if (!store || typeof store.getPNForLID !== 'function') {
            throw new Boom('getPhoneNumber: LID resolution needs an active socket', { statusCode: 400 });
        }
        try {
            const pn = await store.getPNForLID(`${user}@lid`);
            return typeof pn === 'string' && pn.includes('@') ? pn.split('@')[0] : null;
        }
        catch {
            return null;
        }
    }
    return null;
};

export const resolveSenderPn = async (sock, webMessage) => {
    const sender = webMessage?.key?.participant || webMessage?.key?.remoteJid;
    if (!sender || typeof sender !== 'string') {
        throw new Boom('resolveSenderPn(msg) needs a message with key.participant/remoteJid', { statusCode: 400 });
    }
    return getPhoneNumber(sock, sender);
};

export const getLidForPhone = async (sock, phone) => {
    const store = sock?.signalRepository?.lidMapping;
    if (!store || typeof store.getLIDForPN !== 'function') {
        throw new Boom('getLidForPhone(sock, ...) requires an active socket', { statusCode: 400 });
    }
    const pn = typeof phone === 'string' && phone.includes('@')
        ? phone
        : `${String(phone || '').replace(/\D/g, '')}@s.whatsapp.net`;
    if (!pn.split('@')[0]) {
        throw new Boom('getLidForPhone(phone) requires a phone number', { statusCode: 400 });
    }
    try {
        return (await store.getLIDForPN(pn)) || null;
    }
    catch {
        return null;
    }
};

export const validateE164 = (raw) => {
    if (typeof raw !== 'string') {
        throw new TypeError(`Invalid E.164 number: ${String(raw)}`);
    }
    let num = raw.trim();
    if (num.startsWith('+')) {
        num = num.slice(1);
    }
    if (!/^[1-9][0-9]{6,14}$/.test(num)) {
        throw new Error(`Invalid E.164 number: ${raw}`);
    }
    return `+${num}`;
};

export const jidToPhone = (jid) => {
    const match = typeof jid === 'string' ? jid.match(/^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/) : null;
    return match ? match[1] : '';
};

export const phoneToJid = (phone, isGroup = false) => {
    const digits = String(phone ?? '').replace(/[^0-9]/g, '');
    if (!digits) {
        throw new Error(`Cannot build a JID from "${phone}"`);
    }
    return `${digits}@${isGroup ? 'g.us' : 's.whatsapp.net'}`;
};

export const USERNAME_MIN_LENGTH = 3;

export const USERNAME_MAX_LENGTH = 35;

export const USERNAME_PIN_LENGTH = 4;

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const DIGITS = '0123456789';

const LETTER_SET = new Set(LETTERS.split(''));

const ALLOWED_SET = new Set([...LETTERS.split(''), ...DIGITS.split(''), '_', '.']);

const RESERVED_SUFFIXES = ['.com', '.org', '.net', '.int', '.edu', '.gov', '.mil', '.arpa', '.html', '.htm', '.txt', '.xml'];

const RESERVED_WORDS = ['whatsapp', 'instagram', 'facebook', 'oculus'];

const PIN_PATTERN = /^[0-9]{4}$/;

export const UsernameValidationError = {
    INVALID_CHARACTER: 'INVALID_CHARACTER',
    INVALID_LENGTH: 'INVALID_LENGTH',
    INVALID_NO_LETTERS: 'INVALID_NO_LETTERS',
    INVALID_PERIODS: 'INVALID_PERIODS',
    INVALID_DOMAIN_SUFFIX: 'INVALID_DOMAIN_SUFFIX',
    INVALID_WWW_PREFIX: 'INVALID_WWW_PREFIX',
    INVALID_WORD: 'INVALID_WORD'
};

export const stripUsernamePrefix = (username) => {
    return typeof username === 'string' && username.startsWith('@') ? username.slice(1) : username;
};

export const displayUsername = (username) => {
    return '@' + stripUsernamePrefix(username);
};

export const validateUsername = (username) => {
    const value = stripUsernamePrefix(username);
    if (typeof value !== 'string') {
        return { isValid: false, errorType: UsernameValidationError.INVALID_CHARACTER };
    }
    const characters = Array.from(value);
    if (!characters.every(character => ALLOWED_SET.has(character))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_CHARACTER };
    }
    if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_LENGTH };
    }
    if (!characters.some(character => LETTER_SET.has(character))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_NO_LETTERS };
    }
    if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_PERIODS };
    }
    const lowered = value.toLowerCase();
    if (lowered.startsWith('www.')) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_WWW_PREFIX };
    }
    if (RESERVED_SUFFIXES.some(suffix => lowered.endsWith(suffix))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_DOMAIN_SUFFIX };
    }
    if (RESERVED_WORDS.some(word => lowered.includes(word))) {
        return { isValid: false, errorType: UsernameValidationError.INVALID_WORD };
    }
    return { isValid: true };
};

export const isUsernamePin = (pin) => {
    return typeof pin === 'string' && PIN_PATTERN.test(pin);
};
