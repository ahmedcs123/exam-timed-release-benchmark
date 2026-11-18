// Arm B logic against an in-memory store (no Docker needed).
import { test } from 'node:test';
import { MemoryStore } from '../src/store.js';
import { defineScenarios } from './scenarios.js';

defineScenarios(test, async () => new MemoryStore());
