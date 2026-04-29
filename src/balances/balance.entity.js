require('reflect-metadata');

const { EntitySchema } = require('typeorm');

/*
 * Balance entity — SQLite table: `balances`
 *
 * Stores the local shadow copy of HCM balances.
 *
 * Key design notes (see TRD §6):
 *   - Unique constraint on (employeeId, locationId) — one row per employee/location pair.
 *   - `version`      — optimistic concurrency counter; incremented on every write.
 *   - `lastSyncedAt` — when we last fetched this balance from HCM; used to detect staleness.
 *   - `balance`      — stored as decimal text in SQLite; always coerce with parseFloat() before arithmetic.
 */
const Balance = new EntitySchema({
  name:      'Balance',
  tableName: 'balances',
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
    balance: {
      type:      'decimal',
      precision: 10,
      scale:     2,
      nullable:  false,
      default:   0,
    },
    version: {
      type:     'integer',
      nullable: false,
      default:  1,
    },
    lastSyncedAt: {
      type:     'datetime',
      nullable: true,
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
  uniques: [
    { columns: ['employeeId', 'locationId'] },
  ],
});

module.exports.Balance = Balance;