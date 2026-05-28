/**
 * Jest global setup — mock all external dependencies
 * so tests run without DB / Firebase / Redis
 */

'use strict';

// ── DB Mock ──────────────────────────────────────────────────
jest.mock('../src/models/db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  pool: { end: jest.fn() },
}));

// ── Firebase Admin Mock ─────────────────────────────────────
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(() => ({})),
  credential: {
    cert: jest.fn(),
    applicationDefault: jest.fn(),
  },
  messaging: jest.fn(() => ({
    send: jest.fn().mockResolvedValue('mock-message-id'),
  })),
}));

// ── node-cron Mock ───────────────────────────────────────────
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

// Increase test timeout for integration-style tests
jest.setTimeout(15000);
