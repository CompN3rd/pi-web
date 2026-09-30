import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// npm runs predev before forking either owner. A prior build is not readiness
// for this combined startup; dev:web must publish a fresh marker first.
await rm(resolve("dist", ".plugins-ready"), { force: true });
