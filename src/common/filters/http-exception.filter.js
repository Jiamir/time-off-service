const { Catch, HttpException, HttpStatus } = require('@nestjs/common');

/*
 * HttpExceptionFilter — global exception filter
 *
 * Catches every thrown exception and normalises it into the standard error
 * envelope defined in TRD §10:
 *
 *   { error, message, timestamp, path }
 *
 * WHY: NestJS's default error shape is inconsistent across exception types.
 * A single filter gives us one predictable shape for every error response,
 * which makes client-side handling and test assertions simpler.
 */
class HttpExceptionFilter {
  catch(exception, host) {
    const ctx      = host.switchToHttp();
    const response = ctx.getResponse();
    const request  = ctx.getRequest();

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let error   = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      status = exception.getStatus();

      const body = exception.getResponse();

      // getResponse() returns either a plain string or an object.
      // When we throw new BadRequestException({ error, message }) the body
      // is an object; when NestJS throws internally it may be a string.
      if (typeof body === 'object' && body !== null) {
        error   = body.error   || error;
        message = body.message || message;
      } else {
        message = body;
      }
    } else if (exception instanceof Error) {
      // Unexpected JS errors (programmer mistakes, TypeORM internals, etc.)
      message = exception.message;
    }

    console.error(
      `[${new Date().toISOString()}] ${status} ${request.method} ${request.url} — ${message}`
    );

    response.status(status).json({
      error,
      message,
      timestamp: new Date().toISOString(),
      path:      request.url,
    });
  }
}

Catch(HttpException)(HttpExceptionFilter);
module.exports.HttpExceptionFilter = HttpExceptionFilter;