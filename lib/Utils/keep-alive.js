export const createKeepAlive = ({ ping, isOpen, getLastActivity, onDead, onStatus, logger, intervalMs, minIntervalMs, responseTimeoutMs, maxFailTimeMs, random = Math.random }) => {
    const minMs = Math.min(minIntervalMs ?? intervalMs, intervalMs);
    let timer;
    let stopped = true;
    let errors = 0;
    let lastSuccess = Date.now();
    const nextDelay = () => minMs + random() * (intervalMs - minMs);
    const schedule = () => {
        timer = setTimeout(run, nextDelay());
    };
    const run = async () => {
        if (stopped) {
            return;
        }
        if (!isOpen()) {
            logger?.warn('keep alive called when WS not open');
        }
        else {
            let success = false;
            try {
                await ping(responseTimeoutMs);
                success = true;
            }
            catch (err) {
                if (stopped) {
                    return;
                }
                logger?.warn({ trace: err?.stack }, 'keep alive failed');
            }
            if (stopped) {
                return;
            }
            if (success) {
                lastSuccess = Date.now();
                if (errors > 0) {
                    errors = 0;
                    logger?.info('keep alive restored');
                    onStatus?.({ status: 'restored' });
                }
            }
            else {
                errors++;
                onStatus?.({ status: 'timeout', errorCount: errors, lastSuccess: new Date(lastSuccess) });
            }
        }
        const lastActivity = Math.max(getLastActivity() ?? 0, lastSuccess);
        if (Date.now() - lastActivity > maxFailTimeMs) {
            stopped = true;
            onDead();
            return;
        }
        schedule();
    };
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        timer = undefined;
    };
    return {
        start() {
            stop();
            stopped = false;
            errors = 0;
            lastSuccess = Date.now();
            schedule();
        },
        stop
    };
};
