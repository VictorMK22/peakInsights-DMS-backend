/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Scoped to src/tests deliberately — the top-level /tests directory
  // predates this config, imports from paths that don't resolve
  // (`../index`, `../models/...`), and was never wired to a test
  // runner (no "test" script, no jest/supertest/mongodb-memory-server
  // in package.json existed before this). Leaving it out rather than
  // silently "fixing" pre-existing tests that weren't part of this
  // change.
  roots: ["<rootDir>/src/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 30000,
  // mongodb-memory-server downloads a real mongod binary on first run —
  // one download for the whole suite instead of per-file.
  maxWorkers: 1,
};
