const sqlite3 = require('sqlite3');
const BaseDriver = require('@cubejs-backend/query-orchestrator/driver/BaseDriver');

class SqliteDriver extends BaseDriver {
  constructor(config) {
    super();
    this.config = {
      database: process.env.CUBEJS_DB_NAME,
      ...config
    };
    if (!this.config.db) {
      this.config.db = new sqlite3.Database(this.config.database);
    }
  }

  async testConnection() {
    return this.query('SELECT 1');
  }

  query(query, values) {
    return new Promise(
      (resolve, reject) => this.config.db.all(
        query,
        values || [],
        (err, result) => (err ? reject(err) : resolve(result))
      )
    );
  }

  async release() {
    await new Promise((resolve, reject) => this.config.db.close((err) => (err ? reject(err) : resolve())));
  }

  informationSchemaQuery() {
    return `
      SELECT name, sql
      FROM sqlite_master
      WHERE type='table'
      ORDER BY name
   `;
  }

  async tablesSchema() {
    const query = this.informationSchemaQuery();

    const tables = await this.query(query);

    return {
      default: tables.reduce((acc, table) => ({
          ...acc,
          [table.name]: table.sql
              // remove EOL for next .match to read full string
              .replace(/\n/g, '')
              // extract fields
              .match(/\((.*)\)/)[1]
              // split fields
              .split(',')
              .map((nameAndType) => {
                  const match = nameAndType
                    .trim()
                    // obtain "([|`|")?name(]|`|")? type"
                    .match(/(\[|`|")?([^\[\]"`]+)(\]|`|")?\s+(\w+)/)
                  return { name: match[2], type: match[4] };
              })
        }), {}),
    };
  }
}

module.exports = SqliteDriver;
