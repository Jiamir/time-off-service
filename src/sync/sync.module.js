const { Module }          = require('@nestjs/common');
const { SyncService }     = require('./sync.service');
const { SyncController }  = require('./sync.controller');
const { BalancesModule }  = require('../balances/balances.module');
const { BalancesService } = require('../balances/balances.service');
const { HcmModule }       = require('../hcm/hcm.module');
const { HcmService }      = require('../hcm/hcm.service');

const SyncServiceProvider = {
  provide: SyncService,
  useFactory: (balancesService, hcmService) =>
    new SyncService(balancesService, hcmService),
  inject: [BalancesService, HcmService],
};

const SyncControllerProvider = {
  provide: SyncController,
  useFactory: (syncService) => new SyncController(syncService),
  inject: [SyncService],
};

class SyncModule {}

Module({
  imports:     [BalancesModule, HcmModule],
  providers:   [SyncServiceProvider, SyncControllerProvider],
  controllers: [SyncController],
})(SyncModule);

module.exports = { SyncModule };