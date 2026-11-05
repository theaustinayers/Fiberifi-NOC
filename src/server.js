import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, seed } from './db.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
await seed(db, config);

const app = createApp(db, config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Fiberifi NOC listening on http://${config.host}:${config.port}`);
});

const purge = setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600 * 1000);
purge.unref();

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
