// Arm B against the real 3-node etcd cluster. Start it first: npm run etcd:up
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EtcdStore } from '../src/store.js';
import { defineScenarios } from './scenarios.js';

const endpoints = (process.env.ETCD_ENDPOINTS || 'http://127.0.0.1:23791,http://127.0.0.1:23792,http://127.0.0.1:23793').split(',');

test('etcd cluster is reachable', async () => {
  assert.ok(await new EtcdStore(endpoints).healthy(), 'etcd is not running: run `npm run etcd:up` first');
});

defineScenarios(test, async () => new EtcdStore(endpoints));
