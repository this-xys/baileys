import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
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
export default makeWASocket;
