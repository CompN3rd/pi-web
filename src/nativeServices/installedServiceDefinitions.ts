import { TextDecoder } from "node:util";
import type {
  InstalledNativeServiceDefinition,
  InstalledNativeServiceInspection,
} from "./serviceDoctor.js";
import type { NativeServiceBackend, NativeServiceId } from "./servicePlan.js";

export interface InstalledNativeServiceDefinitionSource {
  id: NativeServiceId;
  path: string;
  systemdName: string;
}

export interface InstalledNativeServiceDefinitionCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface InstalledNativeServiceDefinitionDependencies {
  readFile: (path: string) => Uint8Array;
  realpath: (path: string) => string;
  capture: (command: string, args: string[]) => InstalledNativeServiceDefinitionCommandResult;
}

const systemdInspectionProperties = [
  "LoadState",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
  "EnvironmentFiles",
] as const;

type SystemdInspectionProperty = typeof systemdInspectionProperties[number];

/**
 * Read installed definitions through a strict UTF-8 boundary. For systemd,
 * ask the running user manager which fragment and overrides are effective only
 * after taking that snapshot. A subsequent no-reload-needed response ties the
 * snapshot to manager state rather than to a later disk edit. PI WEB only
 * interprets its canonical main fragment; loaded drop-ins and EnvironmentFile
 * inputs fail closed rather than being ignored.
 */
export function inspectInstalledNativeServiceDefinitions(
  backend: NativeServiceBackend,
  sources: readonly InstalledNativeServiceDefinitionSource[],
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<readonly InstalledNativeServiceDefinition[]> {
  const definitions: InstalledNativeServiceDefinition[] = [];
  for (const source of sources) {
    let bytes: Uint8Array;
    try {
      bytes = dependencies.readFile(source.path);
    } catch (error: unknown) {
      return {
        ok: false,
        message: `Could not read installed ${definitionLabel(backend, source.id)} ${source.path}: ${errorMessage(error)}`,
      };
    }

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        message: `Installed ${definitionLabel(backend, source.id)} ${source.path} is not valid UTF-8.`,
      };
    }

    if (backend.kind === "systemd") {
      const managerInspection = inspectEffectiveSystemdDefinition(source, dependencies);
      if (!managerInspection.ok) return managerInspection;
    }
    definitions.push({ id: source.id, contents });
  }
  return { ok: true, value: definitions };
}

function inspectEffectiveSystemdDefinition(
  source: InstalledNativeServiceDefinitionSource,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<null> {
  const args = [
    "--user",
    "--no-pager",
    "show",
    source.systemdName,
    "--all",
    ...systemdInspectionProperties.map((property) => `--property=${property}`),
  ];
  const result = dependencies.capture("systemctl", args);
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stderr, result.stdout);
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: systemctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
    };
  }

  const parsed = parseSystemdInspectionProperties(result.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: ${parsed.message}`,
    };
  }

  const loadState = singleSystemdProperty(parsed.value, "LoadState");
  const fragmentPath = singleSystemdProperty(parsed.value, "FragmentPath");
  const dropInPaths = singleSystemdProperty(parsed.value, "DropInPaths");
  const needDaemonReload = singleSystemdProperty(parsed.value, "NeedDaemonReload");
  if (loadState === undefined || fragmentPath === undefined || dropInPaths === undefined || needDaemonReload === undefined) {
    return {
      ok: false,
      message: `Could not inspect effective systemd unit ${source.systemdName}: systemctl returned incomplete or duplicate unit metadata.`,
    };
  }
  if (loadState !== "loaded") {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} has load state ${JSON.stringify(loadState)} instead of "loaded".`,
    };
  }
  if (needDaemonReload !== "no") {
    return {
      ok: false,
      message: needDaemonReload === "yes"
        ? `Systemd unit ${source.systemdName} has changed on disk; run \`systemctl --user daemon-reload\` before probing it.`
        : `Systemd unit ${source.systemdName} reports unrecognized NeedDaemonReload=${JSON.stringify(needDaemonReload)}.`,
    };
  }
  if (dropInPaths !== "") {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} uses effective drop-ins (${dropInPaths}); PI WEB cannot safely inspect managed config through systemd drop-ins.`,
    };
  }
  const environmentFiles = parsed.value.get("EnvironmentFiles") ?? [];
  const configuredEnvironmentFiles = environmentFiles.filter((value) => value !== "");
  if (configuredEnvironmentFiles.length > 0) {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} uses EnvironmentFile inputs (${configuredEnvironmentFiles.join(", ")}); PI WEB cannot safely inspect their managed config values.`,
    };
  }

  let actualFragmentPath: string;
  let expectedFragmentPath: string;
  try {
    actualFragmentPath = dependencies.realpath(fragmentPath);
    expectedFragmentPath = dependencies.realpath(source.path);
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Could not compare systemd fragment ${fragmentPath} with installed definition ${source.path}: ${errorMessage(error)}`,
    };
  }
  if (actualFragmentPath !== expectedFragmentPath) {
    return {
      ok: false,
      message: `Systemd loaded ${source.systemdName} from ${fragmentPath} instead of the installed PI WEB definition ${source.path}.`,
    };
  }
  return { ok: true, value: null };
}

function parseSystemdInspectionProperties(
  output: string,
): InstalledNativeServiceInspection<ReadonlyMap<SystemdInspectionProperty, readonly string[]>> {
  const properties = new Map<SystemdInspectionProperty, string[]>();
  for (const property of systemdInspectionProperties) properties.set(property, []);

  for (const line of output.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    if (separator < 0 || !isSystemdInspectionProperty(name)) {
      return { ok: false, message: "systemctl returned unrecognized unit metadata." };
    }
    properties.get(name)?.push(line.slice(separator + 1));
  }
  // systemctl's EnvironmentFiles formatter emits no line for an empty array,
  // even with --all. The other scalar/array properties must always be present.
  const requiredProperties = systemdInspectionProperties.filter((property) => property !== "EnvironmentFiles");
  if (requiredProperties.some((property) => (properties.get(property)?.length ?? 0) === 0)) {
    return { ok: false, message: "systemctl omitted required unit metadata." };
  }
  return { ok: true, value: properties };
}

function singleSystemdProperty(
  properties: ReadonlyMap<SystemdInspectionProperty, readonly string[]>,
  name: Exclude<SystemdInspectionProperty, "EnvironmentFiles">,
): string | undefined {
  const values = properties.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

function isSystemdInspectionProperty(value: string): value is SystemdInspectionProperty {
  return systemdInspectionProperties.some((property) => property === value);
}

function definitionLabel(backend: NativeServiceBackend, id: NativeServiceId): string {
  return backend.kind === "systemd" ? `${id} systemd unit` : `${id} LaunchAgent`;
}

function firstOutputLine(...values: readonly string[]): string | undefined {
  for (const value of values) {
    const line = value.trim().split("\n").find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
