// Container entry point for Arm B. Env: PORT (8080), ETCD_ENDPOINTS (comma list),
// CLOCK_SKEW_MS (0, test F5 only), CENSOR_CENTRES (comma list of centre ids, test F6 only).
import { EtcdStore } from './store.js';
import { startCoordinator } from './coordinator.js';

const endpoints = (process.env.ETCD_ENDPOINTS || 'http://etcd1:2379,http://etcd2:2379,http://etcd3:2379').split(',');
const store = new EtcdStore(endpoints);
const srv = await startCoordinator({
  store,
  port: Number(process.env.PORT || 8080),
  host: '0.0.0.0',
  clockSkewMs: Number(process.env.CLOCK_SKEW_MS || 0),
  censoredCentres: new Set((process.env.CENSOR_CENTRES || '').split(',').filter(Boolean)),
});
console.log(`arm-b coordinator listening on ${srv.url}, etcd ${endpoints.join(',')}`);
process.on('SIGTERM', async () => { await srv.close(); process.exit(0); });
