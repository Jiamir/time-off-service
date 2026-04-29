require('reflect-metadata');

const { EntitySchema } = require('typeorm');

/*
 * TimeOffRequest entity — SQLite table: `time_off_requests`
 *
 * Represents one employee's leave request and its full lifecycle.
 *
 * Key design notes (see TRD §6):
 *   - status is a varchar enum: PENDING | APPROVED | REJECTED | CANCELLED
 *   - Transitions are enforced in TimeOffRequestsService, not at DB level
 *     (SQLite doesn't support CHECK constraints via TypeORM EntitySchema easily)
 *   - startDate / endDate stored as varchar ISO strings (SQLite has no DATE type)
 *   - hcmConfirmed: true only after HCM has acknowledged the deduction
 *   - Two indices: one on employeeId alone (for listing), one compound for
 *     the available-balance query (employeeId + locationId + status)
 */
const TimeOffRequest = new EntitySchema({
  name:      'TimeOffRequest',
  tableName: 'time_off_requests',
  columns: {
    id: {
      type:      'integer',
      primary:   true,
      generated: true,
    },
    employeeId: {
      type:     'varchar',
      nullable: false,
    },
    locationId: {
      type:     'varchar',
      nullable: false,
    },
    startDate: {
      type:     'varchar',   // ISO date string: '2025-02-10'
      nullable: false,
    },
    endDate: {
      type:     'varchar',
      nullable: false,
    },
    days: {
      type:     'integer',
      nullable: false,
    },
    status: {
      type:     'varchar',
      nullable: false,
      default:  'PENDING',
      // Valid values: PENDING | APPROVED | REJECTED | CANCELLED
    },
    reason: {
      type:     'text',
      nullable: true,
    },
    rejectionReason: {
      type:     'text',
      nullable: true,
    },
    hcmConfirmed: {
      type:     'boolean',
      nullable: false,
      default:  false,
    },
    createdAt: {
      type:       'datetime',
      createDate: true,
    },
    updatedAt: {
      type:       'datetime',
      updateDate: true,
    },
  },
  indices: [
    { columns: ['employeeId'] },
    { columns: ['employeeId', 'locationId', 'status'] },
  ],
});

module.exports.TimeOffRequest = TimeOffRequest;