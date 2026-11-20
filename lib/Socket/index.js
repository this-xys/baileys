import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { createAutoReconnect } from './auto-reconnect.js';
import { triggerAutoFollow } from './newsletter.js';
import { makeUsernameSocket } from './username.js';
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    const sock = makeUsernameSocket(newConfig);
    triggerAutoFollow(sock, newConfig);
    return sock;
};
export const makeAutoReconnectSocket = (getConfig, options) => createAutoReconnect(makeWASocket, getConfig, options);
export default makeWASocket;
