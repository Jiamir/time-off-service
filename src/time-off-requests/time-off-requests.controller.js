const {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Inject,
} = require('@nestjs/common');
const { TimeOffRequestsService } = require('./time-off-requests.service');

class TimeOffRequestsController {
  constructor(timeOffRequestsService) {
    this.service = timeOffRequestsService;
  }

  async list(employeeId, locationId) {
    return this.service.findByEmployee(employeeId, locationId);
  }

  async findOne(id) {
    return this.service.findById(id);
  }

  async submit(body) {
    return this.service.submit(body);
  }

  async approve(id) {
    return this.service.approve(id);
  }

  async reject(id, body) {
    return this.service.reject(id, body.reason);
  }

  async cancel(id) {
    return this.service.cancel(id);
  }
}

Controller('time-off-requests')(TimeOffRequestsController);
Inject(TimeOffRequestsService)(TimeOffRequestsController, undefined, 0);

const listDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'list');
Get()(TimeOffRequestsController.prototype, 'list', listDesc);
Query('employeeId')(TimeOffRequestsController.prototype, 'list', 0);
Query('locationId')(TimeOffRequestsController.prototype, 'list', 1);

const findOneDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'findOne');
Get(':id')(TimeOffRequestsController.prototype, 'findOne', findOneDesc);
Param('id', ParseIntPipe)(TimeOffRequestsController.prototype, 'findOne', 0);

const submitDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'submit');
Post()(TimeOffRequestsController.prototype, 'submit', submitDesc);
HttpCode(HttpStatus.CREATED)(TimeOffRequestsController.prototype, 'submit', submitDesc);
Body()(TimeOffRequestsController.prototype, 'submit', 0);

const approveDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'approve');
Patch(':id/approve')(TimeOffRequestsController.prototype, 'approve', approveDesc);
Param('id', ParseIntPipe)(TimeOffRequestsController.prototype, 'approve', 0);

const rejectDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'reject');
Patch(':id/reject')(TimeOffRequestsController.prototype, 'reject', rejectDesc);
Param('id', ParseIntPipe)(TimeOffRequestsController.prototype, 'reject', 0);
Body()(TimeOffRequestsController.prototype, 'reject', 1);

const cancelDesc = Object.getOwnPropertyDescriptor(TimeOffRequestsController.prototype, 'cancel');
Patch(':id/cancel')(TimeOffRequestsController.prototype, 'cancel', cancelDesc);
Param('id', ParseIntPipe)(TimeOffRequestsController.prototype, 'cancel', 0);

module.exports.TimeOffRequestsController = TimeOffRequestsController;