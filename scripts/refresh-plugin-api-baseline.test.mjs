import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { publicApiDeclarationPaths } from "./refresh-plugin-api-baseline.mjs";

it.each(["direct", "symlink", "invalid destination"])("refreshes baselines through the real CLI (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-baseline-"));
  const baseline = join(root, "test-fixtures", "plugin-api-baseline");
  const entry = join(root, "scripts", "refresh.mjs");
  try {
    await mkdir(dirname(entry), { recursive: true });
    await copyFile(new URL("./refresh-plugin-api-baseline.mjs", import.meta.url), entry);
    for (const path of publicApiDeclarationPaths) {
      await mkdir(dirname(join(root, "dist", path)), { recursive: true });
      await mkdir(dirname(join(baseline, path)), { recursive: true });
      await writeFile(join(root, "dist", path), `new ${path}`);
      await writeFile(join(baseline, path), `old ${path}`);
    }
    let command = entry;
    if (mode === "symlink") { command = join(root, "linked.mjs"); await symlink(entry, command); }
    if (mode === "invalid destination") {
      await rm(join(baseline, "shared"), { recursive: true });
      await writeFile(join(baseline, "shared"), "not a directory");
    }
    const result = spawnSync(process.execPath, [command], { encoding: "utf8" });
    if (mode === "invalid destination") {
      // Deliberately fail before replacements; tracked files must remain unchanged.
      expect(result.status).not.toBe(0);
      expect(await readFile(join(baseline, "plugin-api.d.ts"), "utf8")).toBe("old plugin-api.d.ts");
      expect(await readFile(join(baseline, "server-plugin-api.d.ts"), "utf8")).toBe("old server-plugin-api.d.ts");
    } else {
      expect(result.status, result.stderr).toBe(0);
      for (const path of publicApiDeclarationPaths) expect(await readFile(join(baseline, path), "utf8")).toBe(`new ${path}`);
    }
    expect((await readdir(baseline)).some((name) => name.startsWith(".refresh-"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
