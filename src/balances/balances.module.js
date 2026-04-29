const { Module }              = require('@nestjs/common');
const { TypeOrmModule, getRepositoryToken } = require('@nestjs/typeorm');

const { Balance }            = require('./balance.entity');
const { TimeOffRequest }     = require('../time-off-requests/time-off-request.entity');
const { BalancesService }    = require('./balances.service');
const { BalancesController } = require('./balances.controller');
const { HcmModule }          = require('../hcm/hcm.module');
const { HcmService }         = require('../hcm/hcm.service');

const BalancesServiceProvider = {
  provide:    BalancesService,
  useFactory: (balanceRepo, hcmService, requestRepo) =>
    new BalancesService(balanceRepo, hcmService, requestRepo),
  inject: [
    getRepositoryToken(Balance),
    HcmService,
    getRepositoryToken(TimeOffRequest),
  ],
};

const BalancesControllerProvider = {
  provide:    BalancesController,
  useFactory: (balancesService) => new BalancesController(balancesService),
  inject:     [BalancesService],
};

class BalancesModule {}

Module({
  imports:     [TypeOrmModule.forFeature([Balance, TimeOffRequest]), HcmModule],
  providers:   [BalancesServiceProvider, BalancesControllerProvider],
  controllers: [BalancesController],
  exports:     [BalancesService],
})(BalancesModule);

module.exports.BalancesModule = BalancesModule;