// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Test temp data always belongs to the repository's canonical runtime work area. */
export const testScratchRoot = join(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), ".mazzy", "work", "test");