#!/usr/bin/env -S node --experimental-strip-types

import { errorReport, run } from "../src/cli.ts";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${errorReport(error)}\n`);
  process.exitCode = 1;
}
