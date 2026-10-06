#!/usr/bin/env node
import { main } from './main.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`tiergear: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
