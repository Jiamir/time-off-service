const { Module }              = require('@nestjs/common');
const { TypeOrmModule, getRepositoryToken } = require('@nestjs/typeorm');

const { TimeOffRequest }            = require('./time-off-request.entity');
const { Balance }                   = require('../balances/balance.entity');
const { TimeOffRequestsService }    = require('./time-off-requests.service');
const { TimeOffRequestsController } = require('./time-off-requests.controller');
const { BalancesModule }            = require('../balances/balances.module');
const { BalancesService }           = require('../balances/balances.service');
const { HcmModule }                 = require('../hcm/hcm.module');
const { HcmService }                = require('../hcm/hcm.service');

const TimeOffRequestsServiceProvider = {
  provide:    TimeOffRequestsService,
  useFactory: (requestRepo, balancesService, hcmService) =>
    new TimeOffRequestsService(requestRepo, balancesService, hcmService),
  inject: [
    getRepositoryToken(TimeOffRequest),
    BalancesService,
    HcmService,
  ],
};

const TimeOffRequestsControllerProvider = {
  provide:    TimeOffRequestsController,
  useFactory: (service) => new TimeOffRequestsController(service),
  inject:     [TimeOffRequestsService],
};

class TimeOffRequestsModule {}

Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Balance]),
    BalancesModule,
    HcmModule,
  ],
  providers:   [TimeOffRequestsServiceProvider, TimeOffRequestsControllerProvider],
  controllers: [TimeOffRequestsController],
  exports:     [TimeOffRequestsService],
})(TimeOffRequestsModule);

module.exports.TimeOffRequestsModule = TimeOffRequestsModule;