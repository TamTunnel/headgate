// Dev helper: drop and recreate the headgate database schema.
import { Client } from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgres://headgate:headgate-dev@127.0.0.1:5432/headgate";
const client = new Client({ connectionString: url });
await client.connect();
await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
await client.end();
console.log("Schema dropped. Run the server (or migrate) to recreate it.");
