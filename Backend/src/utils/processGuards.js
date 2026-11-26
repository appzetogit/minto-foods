/**
 * Last-resort handlers for errors nothing else caught.
 *
 * An unhandled rejection used to shut the process down in production. In the
 * API cluster that dropped every request the worker was serving at that moment
 * (nginx answers those with 502), and the stray promise was usually a side
 * effect -- a push, a socket emit -- whose failure should not have touched the
 * request at all. A rejected promise leaves nothing half-done in this process,
 * so it is now logged with its stack and the process carries on.
 *
 * An uncaught exception is different: it can leave the process in an unknown
 * state, so it is logged with its stack and the process still exits, letting
 * PM2 start a clean one.
 *
 * Both used to log only `err.message`, which says what failed but not where.
 */
export const describeError = (err) => {
    if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
    try {
        return typeof err === 'string' ? err : (JSON.stringify(err) ?? String(err));
    } catch {
        return String(err);
    }
};

export const installProcessGuards = ({
    logger,
    name = 'Server',
    exitOnUncaught = true,
    exit = (code) => process.exit(code),
    proc = process,
} = {}) => {
    const onRejection = (reason) => {
        logger.error(`${name} unhandled rejection (process kept running): ${describeError(reason)}`);
    };
    const onException = (err) => {
        logger.error(`${name} uncaught exception: ${describeError(err)}`);
        if (exitOnUncaught) exit(1);
    };
    proc.on('unhandledRejection', onRejection);
    proc.on('uncaughtException', onException);
    return { onRejection, onException };
};
