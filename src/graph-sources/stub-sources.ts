// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import type { GraphDelta, GraphSource } from "../graph-model.ts";

/**
 * Reserved sources for R10 (tiered memory + LanceDB vectors). They exist now so
 * that adding real hot/warm/cold memory and vector retrieval is a file edit, not
 * an architecture change: register the real implementation, and it appears in the
 * graph as a new lane + legend chip with zero client changes. Until then they
 * report unavailable and never contribute nodes.
 */
export class MemorySource implements GraphSource {
  readonly id = "memory";
  available(): boolean { return false; }
  load(): GraphDelta { throw new Error("memory source not implemented (R10)"); }
}

export class VectorsSource implements GraphSource {
  readonly id = "vectors";
  available(): boolean { return false; }
  load(): GraphDelta { throw new Error("vectors (LanceDB) source not implemented (R10)"); }
}