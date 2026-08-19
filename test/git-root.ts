import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Test temp data always belongs to the repository's canonical runtime work area. */
export const testScratchRoot = join(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), ".mazzy", "work", "test");
