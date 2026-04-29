const {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Inject,
} = require('@nestjs/common');
const { SyncService } = require('./sync.service');

class SyncController {
  constructor(syncService) {
    this.syncService = syncService;
  }

  async batch(body) {
    if (!Array.isArray(body?.balances) || body.balances.length === 0) {
      throw new BadRequestException({
        error:   'INVALID_PAYLOAD',
        message: 'Request body must include a non-empty `balances` array.',
      });
    }
    return this.syncService.processBatch(body.balances);
  }

  async refresh(employeeId, locationId) {
    return this.syncService.refreshOne(employeeId, locationId);
  }
}

Controller('sync')(SyncController);
Inject(SyncService)(SyncController, undefined, 0);

const batchDesc = Object.getOwnPropertyDescriptor(SyncController.prototype, 'batch');
Post('batch')(SyncController.prototype, 'batch', batchDesc);
HttpCode(HttpStatus.OK)(SyncController.prototype, 'batch', batchDesc);
Body()(SyncController.prototype, 'batch', 0);

const refreshDesc = Object.getOwnPropertyDescriptor(SyncController.prototype, 'refresh');
Post('refresh/:employeeId/:locationId')(SyncController.prototype, 'refresh', refreshDesc);
HttpCode(HttpStatus.OK)(SyncController.prototype, 'refresh', refreshDesc);
Param('employeeId')(SyncController.prototype, 'refresh', 0);
Param('locationId')(SyncController.prototype, 'refresh', 1);

module.exports.SyncController = SyncController;