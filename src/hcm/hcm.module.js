const { Module } = require('@nestjs/common');
const { HcmService } = require('./hcm.service');

class HcmModule {}

Module({
  providers: [HcmService],
  exports: [HcmService], // required so other modules (like Balances) can inject it
})(HcmModule);

module.exports = { HcmModule };