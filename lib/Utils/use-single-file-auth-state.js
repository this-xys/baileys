import { createRequire } from 'module';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';

const require = createRequire(import.meta.url);

const KEY_MAP = {
    'pre-key': 'preKeys',
    'session': 'sessions',
    'sender-key': 'senderKeys',
    'app-state-sync-key': 'appStateSyncKeys',
    'app-state-sync-version': 'appStateVersions',
    'sender-key-memory': 'senderKeyMemory'
};

export const useSingleFileAuthState = (filename, logger) => {
    const { readFileSync, writeFileSync, existsSync } = require('fs');
    let creds;
    let keys = {};
    const saveState = () => {
        logger && logger.trace('saving auth state');
        writeFileSync(filename,
            JSON.stringify({ creds, keys }, BufferJSON.replacer, 2));
    };
    if (existsSync(filename)) {
        const result = JSON.parse(readFileSync(filename, { encoding: 'utf-8' }), BufferJSON.reviver);
        creds = result.creds;
        keys = result.keys;
    }
    else {
        creds = initAuthCreds();
        keys = {};
    }
    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const key = KEY_MAP[type];
                    return ids.reduce((dict, id) => {
                        let value = keys[key]?.[id];
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            dict[id] = value;
                        }
                        return dict;
                    }, {});
                },
                set: (data) => {
                    for (const _key in data) {
                        const key = KEY_MAP[_key];
                        keys[key] = keys[key] || {};
                        Object.assign(keys[key], data[_key]);
                    }
                    saveState();
                }
            }
        },
        saveState
    };
};
