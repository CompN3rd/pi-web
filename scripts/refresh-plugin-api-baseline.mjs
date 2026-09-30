import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const publicApiDeclarationPaths = [
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
  "shared/pluginApiTypes.d.ts",
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function refreshBaseline() {
  // Read everything first: a missing build must not partially refresh the baseline.
  const contents = await Promise.all(publicApiDeclarationPaths.map((path) => readFile(resolve(repoRoot, "dist", path))));
  await Promise.all(publicApiDeclarationPaths.map(async (path, index) => {
    const destination = resolve(repoRoot, "test-fixtures", "plugin-api-baseline", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents[index]);
  }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await refreshBaseline();
