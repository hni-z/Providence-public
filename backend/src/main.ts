import { createApp } from './app.js';
import { configFromEnv, loadEnvironment } from './config.js';
loadEnvironment();
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const server = createApp(configFromEnv()).listen(port, '127.0.0.1', () => {
  console.log(`Providence review: http://127.0.0.1:${port}. Provider and session credentials are never logged.`);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.maxConnections = 30;
