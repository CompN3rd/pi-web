#!/usr/bin/env node
import { watch } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const rootDir = resolve("pi-web-plugins");
const outDir = resolve("dist/pi-web-plugins");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

if (watchMode) {
  await watchAndBuild();
} else {
  await buildAll();
}

async function buildAll() {
  // Keep the last successful build available while compiling (including on errors).
  await mkdir(dirname(outDir), { recursive: true });
  const stagingDir = await mkdtemp(`${outDir}-build-`);
  try {
    const result = await buildDirectory(rootDir, stagingDir);
    await rm(outDir, { recursive: true, force: true });
    await rename(stagingDir, outDir);
    const suffix = result.transpiled === 1 ? "file" : "files";
    console.log(`[plugins] built ${String(result.transpiled)} TypeScript plugin ${suffix} into ${relative(cwd, outDir)}`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function buildDirectory(sourceDir, targetDir) {
  const entries = await readDirectory(sourceDir);
  let copied = 0;
  let transpiled = 0;

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      const result = await buildDirectory(sourcePath, targetPath);
      copied += result.copied;
      transpiled += result.transpiled;
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".d.ts")) continue;

    if (isPluginSource(entry.name)) {
      await buildFile(sourcePath, targetPath.replace(/\.ts$/u, ".js"));
      transpiled += 1;
      continue;
    }

    if (entry.name.endsWith(".js") && await hasTypeScriptSource(sourcePath)) continue;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }

  return { copied, transpiled };
}

async function buildFile(file, outputPath) {
  const source = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });

  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));

  const output = `// Generated from ${relative(cwd, file)}. Do not edit directly.\n${transpiled.outputText}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}

function isPluginSource(fileName) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

async function hasTypeScriptSource(javaScriptPath) {
  const typeScriptPath = javaScriptPath.replace(/\.js$/u, ".ts");
  try {
    await readFile(typeScriptPath, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function watchAndBuild() {
  let watcher;
  let timer;
  let building = false;
  let pending = false;

  const refreshWatcher = () => {
    watcher?.close();
    try {
      watcher = watch(rootDir, { recursive: true }, (_event, filename) => {
        if (filename?.toString().split(/[\\/]/u).includes("node_modules")) return;
        scheduleBuild();
      });
      watcher.on("error", (error) => {
        console.error(`[plugins] ${formatUnknownError(error)}`);
        scheduleBuild();
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  };

  const runBuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      do {
        pending = false;
        refreshWatcher();
        await buildAll();
      } while (pending);
    } catch (error) {
      console.error(`[plugins] ${formatUnknownError(error)}`);
    } finally {
      building = false;
    }
  };

  const scheduleBuild = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runBuild();
    }, 100);
  };

  // The root itself can be absent or replaced; its parent stays watched.
  const parentWatcher = watch(cwd, (_event, filename) => {
    if (filename === null || filename.toString() === "pi-web-plugins") scheduleBuild();
  });
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
    parentWatcher.close();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await runBuild();
  console.log(`[plugins] watching ${relative(cwd, rootDir)}`);
  await new Promise(() => undefined);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n",
  });
}

function formatUnknownError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
