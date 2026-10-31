/**
 * Requests no route matched.
 *
 * Without this Express answered with its own HTML "Cannot GET /x" page, which
 * an API client cannot parse. The body has the same shape errorHandler gives
 * every other failure.
 */
const notFound = (req, res) => {
    const message = `Route not found: ${req.method} ${req.path}`;
    res.status(404).json({
        success: false,
        message,
        error: message,
    });
};

export default notFound;
