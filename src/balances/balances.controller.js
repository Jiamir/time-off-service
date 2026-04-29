const { Controller, Get, Param, Inject } = require('@nestjs/common');
const { BalancesService } = require('./balances.service');

class BalancesController {
  constructor(balancesService) {
    this.balancesService = balancesService;
  }

  async getBalance(employeeId, locationId) {
    return this.balancesService.getBalance(employeeId, locationId);
  }
}

Controller('balances')(BalancesController);
Inject(BalancesService)(BalancesController, undefined, 0);

const getBalanceDesc = Object.getOwnPropertyDescriptor(BalancesController.prototype, 'getBalance');
Get(':employeeId/:locationId')(BalancesController.prototype, 'getBalance', getBalanceDesc);
Param('employeeId')(BalancesController.prototype, 'getBalance', 0);
Param('locationId')(BalancesController.prototype, 'getBalance', 1);

module.exports.BalancesController = BalancesController;