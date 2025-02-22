const mysql = require('mysql');
const genericPool = require('generic-pool');
const { promisify } = require('util');
const BaseDriver = require('@cubejs-backend/query-orchestrator/driver/BaseDriver');

const GenericTypeToMySql = {
  'string': 'varchar(255)'
};

class MySqlDriver extends BaseDriver {
  constructor(config) {
    super();
    this.config = {
      host: process.env.CUBEJS_DB_HOST,
      database: process.env.CUBEJS_DB_NAME,
      port: process.env.CUBEJS_DB_PORT,
      user: process.env.CUBEJS_DB_USER,
      password: process.env.CUBEJS_DB_PASS,
      ...config
    };
    this.pool = genericPool.createPool({
      create: async () => {
        const conn = mysql.createConnection(this.config);
        const connect = promisify(conn.connect.bind(conn));

        conn.on && conn.on('error', (err) => {
          conn.destroy();
        });
        conn.execute = promisify(conn.query.bind(conn));

        await connect();
        return conn;
      },
      destroy: (connection) => {
        return promisify(connection.end.bind(connection))();
      },
      validate: async (connection) => {
        try {
          await connection.execute('SELECT 1');
        } catch (e) {
          return false;
        }
        return true;
      }
    }, {
      min: 0,
      max: 8,
      evictionRunIntervalMillis: 10000,
      softIdleTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      testOnBorrow: true,
      acquireTimeoutMillis: 20000
    });
  }

  withConnection(fn) {
    const self = this;
    const connectionPromise = this.pool.acquire();

    let cancelled = false;
    const cancelObj = {};
    const promise = connectionPromise.then(conn => {
      cancelObj.cancel = async () => {
        cancelled = true;
        await self.withConnection(async conn => {
          const processRows = await conn.execute('SHOW PROCESSLIST');
          await Promise.all(processRows.filter(row => row.Time >= 599).map(row => {
            return conn.execute(`KILL ${row.Id}`);
          }));
        });
      };
      return fn(conn)
        .then(res => {
          return this.pool.release(conn).then(() => {
            if (cancelled) {
              throw new Error('Query cancelled');
            }
            return res;
          });
        })
        .catch((err) => {
          return this.pool.release(conn).then(() => {
            if (cancelled) {
              throw new Error('Query cancelled');
            }
            throw err;
          });
        })
    });
    promise.cancel = () => cancelObj.cancel();
    return promise;
  }

  async testConnection() {
    const conn = await this.pool._factory.create();
    try {
      return await conn.execute('SELECT 1');
    } finally {
      await this.pool._factory.destroy(conn);
    }
  }

  query(query, values) {
    const self = this;
    return this.withConnection(db => {

      return db.execute(`SET time_zone = '${self.config.storeTimezone || '+00:00'}'`, [])
        .then(() => db.execute(query, values))
        .then(res => res);
    });
  }

  async release() {
    await this.pool.drain();
    await this.pool.clear();
  }

  informationSchemaQuery() {
    return `${super.informationSchemaQuery()} AND columns.table_schema = '${this.config.database}'`
  }

  quoteIdentifier(identifier) {
    return `\`${identifier}\``;
  }

  fromGenericType(columnType) {
    return GenericTypeToMySql[columnType] || super.fromGenericType(columnType);
  }

  toColumnValue(value, genericType) {
    if (genericType === 'text') {
      return value && value.replace(/[\u0800-\uFFFF]/g, '');
    }
    return super.toColumnValue(value, genericType);
  }

  async uploadTable(table, columns, tableData) {
    if (!tableData.rows) {
      throw new Error(`${this.constructor} driver supports only rows upload`);
    }
    await this.createTable(table, columns);
    try {
      const batchSize = 100; // TODO make dynamic?
      for (let j = 0; j < Math.ceil(tableData.rows.length / batchSize); j++) {
        const currentBatchSize = Math.min(tableData.rows.length - j * batchSize, batchSize);
        const indexArray = Array.from({ length: currentBatchSize }, (v, i) => i);
        const valueParamPlaceholders =
          indexArray.map(i => `(${columns.map((c, paramIndex) => this.param(paramIndex + i * columns.length)).join(', ')})`).join(', ');
        const params = indexArray.map(i => columns
          .map(c => this.toColumnValue(tableData.rows[i + j * batchSize][c.name], c.type)))
          .reduce((a, b) => a.concat(b), []);

        await this.query(
          `INSERT INTO ${table}
        (${columns.map(c => this.quoteIdentifier(c.name)).join(', ')})
        VALUES ${valueParamPlaceholders}`,
          params
        );
      }
    } catch (e) {
      await this.dropTable(table);
      throw e;
    }
  }
}

module.exports = MySqlDriver;