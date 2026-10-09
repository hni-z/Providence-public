#!/usr/bin/env node
import { runSetup, SetupError } from './connect-helpers.mjs';

try {
  await runSetup();
} catch (error) {
  // Arbitrary network, JSON and process errors may include secrets.
  console.error(error instanceof SetupError ? error.message : 'Setup could not finish. Check your connection and try again.');
  process.exitCode = error instanceof SetupError ? error.exitCode : 1;
}
