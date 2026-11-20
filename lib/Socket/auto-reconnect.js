import { DisconnectReason } from '../Types/index.js';
const TERMINAL_REASONS = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.forbidden,
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch
]);
const defaultShouldReconnect = (error, statusCode) => !!error && !TERMINAL_REASONS.has(statusCode);
export const createAutoReconnect = (makeSocket, getConfig, options = {}) => {
    const { baseDelayMs = 2000, maxDelayMs = 60000, maxAttempts = Infinity, onSocket, shouldReconnect = defaultShouldReconnect, onError, onReconnecting } = options;
    const resolveConfig = typeof getConfig === 'function' ? getConfig : () => getConfig;
    let current;
    let attempts = 0;
    let timer;
    let stopped = false;
    const schedule = (error, immediate) => {
        if (stopped || timer) {
            return;
        }
        let delayMs = 0;
        if (!immediate) {
            if (attempts >= maxAttempts) {
                return;
            }
            delayMs = Math.min(attempts * baseDelayMs, maxDelayMs);
            attempts++;
        }
        onReconnecting?.({ attempt: attempts, delayMs, error });
        timer = setTimeout(() => {
            timer = undefined;
            void spawn();
        }, delayMs);
    };
    const handleFailure = (err) => {
        if (onError && onError(err) === false) {
            return;
        }
        schedule(err, false);
    };
    const spawn = async () => {
        if (stopped) {
            return;
        }
        let config;
        try {
            config = await resolveConfig();
        }
        catch (err) {
            handleFailure(err);
            return;
        }
        if (stopped) {
            return;
        }
        let sock;
        try {
            sock = makeSocket(config);
        }
        catch (err) {
            handleFailure(err);
            return;
        }
        current = sock;
        sock.ev.on('connection.update', update => {
            if (update.connection === 'open') {
                attempts = 0;
            }
            else if (update.connection === 'close' && sock === current && !stopped) {
                const error = update.lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                if (shouldReconnect(error, statusCode)) {
                    schedule(error, statusCode === DisconnectReason.restartRequired);
                }
            }
        });
        try {
            await onSocket?.(sock, { attempt: attempts });
        }
        catch (err) {
            config.logger?.error({ err }, 'error in auto reconnect onSocket');
        }
    };
    const started = spawn();
    return {
        started,
        get sock() {
            return current;
        },
        get attempts() {
            return attempts;
        },
        async stop() {
            stopped = true;
            clearTimeout(timer);
            timer = undefined;
            await started.catch(() => { });
            if (current) {
                await current.end(undefined);
            }
        }
    };
};
