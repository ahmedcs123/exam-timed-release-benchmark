// Container entry point for Arm C. Env: PORT (8080), CLOCK_SKEW_MS (0, test F5 only).
import { startKeyServer } from './server.js';

const srv = await startKeyServer({
  port: Number(process.env.PORT || 8080),
  host: '0.0.0.0',
  clockSkewMs: Number(process.env.CLOCK_SKEW_MS || 0),
});
console.log(`arm-c key server listening on ${srv.url}`);
process.on('SIGTERM', async () => { await srv.close(); process.exit(0); });
