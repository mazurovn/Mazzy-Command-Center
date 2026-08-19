// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Test temp data always belongs to the repository's canonical runtime work area. */
export const testScratchRoot = join(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), ".mazzy", "work", "test");