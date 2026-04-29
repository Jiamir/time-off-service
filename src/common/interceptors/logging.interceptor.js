const { Injectable, NestInterceptor, ExecutionContext, CallHandler } = require('@nestjs/common');
const { tap } = require('rxjs/operators');

/*
 * LoggingInterceptor — request/response logger
 *
 * Logs every incoming HTTP request and its outcome.
 * Registered globally in main.js so it wraps every controller method.
 *
 * WHY an interceptor and not middleware:
 * NestJS interceptors sit inside the dependency-injection context and run
 * after guards/pipes. They also have access to the response observable,
 * which lets us measure the exact duration of the handler (including async
 * DB and HCM calls) without patching the response object directly.
 *
 * WHY not logging inside each service:
 * Services already log HCM failures at the point of failure (where the raw
 * status code and response body are still available). This interceptor handles
 * the orthogonal concern — recording EVERY request start and end, with timing
 * — without touching any service logic.
 *
 * Output format:
 *   --> GET /balances/emp-1/loc-1
 *   <-- GET /balances/emp-1/loc-1 200 (45ms)
 *
 * On uncaught error the interceptor lets the exception propagate naturally
 * to the global HttpExceptionFilter, which handles logging and response
 * formatting. The interceptor does not swallow or transform errors.
 */
class LoggingInterceptor {
  intercept(context, next) {
    const req    = context.switchToHttp().getRequest();
    const method = req.method;
    const url    = req.url;
    const start  = Date.now();

    console.log(`--> ${method} ${url}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          console.log(`<-- ${method} ${url} (${ms}ms)`);
        },
        error: (err) => {
          const ms     = Date.now() - start;
          const status = err?.status || 500;
          console.log(`<-- ${method} ${url} ${status} (${ms}ms)`);
        },
      })
    );
  }
}

Injectable()(LoggingInterceptor);

module.exports.LoggingInterceptor = LoggingInterceptor;