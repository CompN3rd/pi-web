import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const publicApiDeclarationPaths = [
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
  "shared/pluginApiTypes.d.ts",
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function refreshBaseline() {
  // Read everything first: a missing build must not partially refresh the baseline.
  const contents = await Promise.all(publicApiDeclarationPaths.map((path) => readFile(resolve(repoRoot, "dist", path))));
  const baseline = resolve(repoRoot, "test-fixtures", "plugin-api-baseline");
  await mkdir(baseline, { recursive: true });
  const staging = await mkdtemp(join(baseline, ".refresh-"));
  try {
    // Finish staging every write before replacing any tracked baseline file.
    for (const [index, path] of publicApiDeclarationPaths.entries()) {
      const target = resolve(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents[index]);
    }
    for (const path of publicApiDeclarationPaths) await mkdir(dirname(resolve(baseline, path)), { recursive: true });
    // Per-file atomic replacements, not a multi-file filesystem transaction.
    for (const path of publicApiDeclarationPaths) await rename(resolve(staging, path), resolve(baseline, path));
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) await refreshBaseline();
