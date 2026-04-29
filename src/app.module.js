require('reflect-metadata');

const { Module }        = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');

const { BalancesModule }        = require('./balances/balances.module');
const { TimeOffRequestsModule } = require('./time-off-requests/time-off-requests.module');
const { HcmModule }             = require('./hcm/hcm.module');
const { SyncModule }            = require('./sync/sync.module');
const { Balance }               = require('./balances/balance.entity');
const { TimeOffRequest }        = require('./time-off-requests/time-off-request.entity');

/*
 * ─── IMPORTANT: NestJS 11 plain-JS decorator pattern ────────────────────────
 *
 * In NestJS 11, ALL decorators (Module, Injectable, Controller, etc.) mutate
 * the class IN PLACE via Reflect.defineMetadata and return UNDEFINED.
 *
 * WRONG (our previous attempt — exports undefined):
 *   class AppModule {}
 *   module.exports.AppModule = Module({...})(AppModule);  // ← undefined!
 *
 * CORRECT:
 *   class AppModule {}
 *   Module({...})(AppModule);          // mutates AppModule in place
 *   module.exports.AppModule = AppModule;  // export the original class
 *
 * This rule applies to every Module(), Injectable(), Controller(), Catch().
 * ─────────────────────────────────────────────────────────────────────────────
 */

class AppModule {}

Module({
  imports: [
    TypeOrmModule.forRoot({
      type:        'better-sqlite3',
      database:    process.env.DB_PATH || './time-off.db',
      entities:    [Balance, TimeOffRequest],
      synchronize: true,  // auto-creates/migrates tables — fine for dev/test
    }),
    BalancesModule,
    TimeOffRequestsModule,
    HcmModule,
    SyncModule,
  ],
})(AppModule);

module.exports.AppModule = AppModule;