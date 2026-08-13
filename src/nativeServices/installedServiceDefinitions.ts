import { TextDecoder, TextEncoder } from "node:util";
import {
  decodeSystemdEscapes,
  inspectInstalledNativeServiceDefinitionEnvironment,
  type InstalledNativeServiceDefinition,
  type InstalledNativeServiceInspection,
} from "./serviceDoctor.js";
import type { NativeServiceBackend, NativeServiceId } from "./servicePlan.js";

export type InstalledNativeServiceDefinitionPurpose = "start" | "restart" | "doctor";

export interface InstalledNativeServiceDefinitionSource {
  id: NativeServiceId;
  path: string;
  systemdName: string;
  launchdTarget: string;
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
  "Environment",
] as const;

const systemdBusDestination = "org.freedesktop.systemd1";
const systemdUnitObjectPathPrefix = "/org/freedesktop/systemd1/unit/";
const legacySystemdUnprintableValue = "[unprintable]";

type SystemdInspectionProperty = typeof systemdInspectionProperties[number];

/**
 * Read installed definitions through a strict UTF-8 boundary, parse the
 * manager-relevant environment, and then bind that byte snapshot to the
 * service manager's effective context. Systemd must report the canonical
 * fragment, no unmodeled environment inputs, and the same effective
 * environment; legacy systemctl output is recovered losslessly from the
 * manager's D-Bus property. A loaded LaunchAgent must report the canonical
 * plist and the same PI_WEB_CONFIG. Launchd restart is the exception: its existing
 * bootout/bootstrap path deliberately replaces loaded state before probing.
 */
export function inspectInstalledNativeServiceDefinitions(
  backend: NativeServiceBackend,
  sources: readonly InstalledNativeServiceDefinitionSource[],
  dependencies: InstalledNativeServiceDefinitionDependencies,
  purpose: InstalledNativeServiceDefinitionPurpose,
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

    const definition = { id: source.id, contents } as const;
    const environment = inspectInstalledNativeServiceDefinitionEnvironment(backend, definition);
    if (!environment.ok) return environment;

    if (backend.kind === "systemd") {
      const managerInspection = inspectEffectiveSystemdDefinition(source, environment.value, dependencies);
      if (!managerInspection.ok) return managerInspection;
    } else if (purpose !== "restart") {
      const managerInspection = inspectLoadedLaunchdDefinition(source, environment.value, dependencies);
      if (!managerInspection.ok) return managerInspection;
    }
    definitions.push(definition);
  }
  return { ok: true, value: definitions };
}

function inspectEffectiveSystemdDefinition(
  source: InstalledNativeServiceDefinitionSource,
  expectedEnvironment: Readonly<Record<string, string>>,
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
  const effectiveEnvironmentValue = singleSystemdProperty(parsed.value, "Environment");
  if (
    loadState === undefined
    || fragmentPath === undefined
    || dropInPaths === undefined
    || needDaemonReload === undefined
    || effectiveEnvironmentValue === undefined
  ) {
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

  const effectiveEnvironment = inspectEffectiveSystemdEnvironment(
    source,
    effectiveEnvironmentValue,
    dependencies,
  );
  if (!effectiveEnvironment.ok) return effectiveEnvironment;
  if (!recordsEqual(effectiveEnvironment.value, expectedEnvironment)) {
    return {
      ok: false,
      message: `Systemd unit ${source.systemdName} has an effective environment that differs from installed definition ${source.path}; run \`systemctl --user daemon-reload\` or reinstall the managed services before probing it.`,
    };
  }
  return { ok: true, value: null };
}

function inspectLoadedLaunchdDefinition(
  source: InstalledNativeServiceDefinitionSource,
  expectedEnvironment: Readonly<Record<string, string>>,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<null> {
  const result = dependencies.capture("launchctl", ["print", source.launchdTarget]);
  if (result.status !== 0) {
    if (launchdServiceIsMissing(result)) return { ok: true, value: null };
    const detail = firstOutputLine(result.stderr, result.stdout);
    return {
      ok: false,
      message: `Could not inspect loaded LaunchAgent ${source.launchdTarget}: launchctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
    };
  }

  const loaded = parseLaunchdPrintDefinition(result.stdout);
  if (loaded === undefined) {
    return {
      ok: false,
      message: `Could not inspect loaded LaunchAgent ${source.launchdTarget}: launchctl returned an unrecognized service definition.`,
    };
  }

  let actualPlistPath: string;
  let expectedPlistPath: string;
  try {
    actualPlistPath = dependencies.realpath(loaded.path);
    expectedPlistPath = dependencies.realpath(source.path);
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Could not compare loaded LaunchAgent plist ${loaded.path} with installed definition ${source.path}: ${errorMessage(error)}`,
    };
  }
  if (actualPlistPath !== expectedPlistPath) {
    return {
      ok: false,
      message: `Launchd loaded ${source.launchdTarget} from ${loaded.path} instead of the installed PI WEB definition ${source.path}; run \`pi-web restart\` to reload the managed LaunchAgents.`,
    };
  }

  const expectedConfigPath = expectedEnvironment["PI_WEB_CONFIG"];
  const loadedConfigPath = loaded.environment["PI_WEB_CONFIG"];
  if (loadedConfigPath !== expectedConfigPath) {
    return {
      ok: false,
      message: `Loaded LaunchAgent ${source.launchdTarget} has PI_WEB_CONFIG ${JSON.stringify(loadedConfigPath)} instead of installed value ${JSON.stringify(expectedConfigPath)}; run \`pi-web restart\` to reload the managed LaunchAgents.`,
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

function inspectEffectiveSystemdEnvironment(
  source: InstalledNativeServiceDefinitionSource,
  systemctlValue: string,
  dependencies: InstalledNativeServiceDefinitionDependencies,
): InstalledNativeServiceInspection<Readonly<Record<string, string>>> {
  let assignments = parseSystemdSerializedWords(systemctlValue);
  if (assignments === undefined) return unrecognizedSystemdEnvironment(source, "systemctl");
  let environmentSource: "systemctl" | "busctl" = "systemctl";

  if (assignments.includes(legacySystemdUnprintableValue)) {
    // systemctl 239-245 redacts individual string-array entries containing
    // spaces. busctl reads the same manager property and C-escapes it losslessly.
    const result = dependencies.capture("busctl", [
      "--user",
      "get-property",
      systemdBusDestination,
      systemdUnitObjectPath(source.systemdName),
      `${systemdBusDestination}.Service`,
      "Environment",
    ]);
    if (result.status !== 0) {
      const detail = firstOutputLine(result.stderr, result.stdout);
      return {
        ok: false,
        message: `Could not inspect effective systemd unit ${source.systemdName} losslessly: systemctl returned ${legacySystemdUnprintableValue}, and busctl exited with status ${String(result.status)}${detail === undefined ? "" : ` (${detail})`}.`,
      };
    }
    assignments = parseBusctlStringArray(result.stdout);
    if (assignments === undefined) return unrecognizedSystemdEnvironment(source, "busctl");
    environmentSource = "busctl";
  }

  const environment = environmentFromAssignments(assignments);
  return environment === undefined
    ? unrecognizedSystemdEnvironment(source, environmentSource)
    : { ok: true, value: environment };
}

function unrecognizedSystemdEnvironment(
  source: InstalledNativeServiceDefinitionSource,
  command: "systemctl" | "busctl",
): InstalledNativeServiceInspection<never> {
  return {
    ok: false,
    message: `Could not inspect effective systemd unit ${source.systemdName}: ${command} returned an unrecognized Environment value.`,
  };
}

function environmentFromAssignments(assignments: readonly string[]): Readonly<Record<string, string>> | undefined {
  const environment: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const key = assignment.slice(0, separator);
    if (
      separator <= 0
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || Object.hasOwn(environment, key)
    ) return undefined;
    environment[key] = assignment.slice(separator + 1);
  }
  return environment;
}

function parseBusctlStringArray(output: string): string[] | undefined {
  // busctl's terse array format is `as <count> "<C-escaped value>" ...`.
  let line = output;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.includes("\r") || line.includes("\n")) return undefined;

  const header = /^as (0|[1-9][0-9]*)(.*)$/u.exec(line);
  if (header === null) return undefined;
  const count = Number(header[1]);
  if (!Number.isSafeInteger(count)) return undefined;

  const serializedWords = header[2] ?? "";
  const words: string[] = [];
  let offset = 0;
  while (offset < serializedWords.length) {
    if (serializedWords[offset] !== " " || serializedWords[offset + 1] !== "\"") return undefined;
    const parsed = systemdQuotedWord(serializedWords, offset + 1, "\"");
    if (parsed === undefined) return undefined;
    const decoded = decodeSystemdEscapes(parsed.raw);
    if (decoded === undefined) return undefined;
    words.push(decoded);
    offset = parsed.nextOffset;
  }
  return words.length === count ? words : undefined;
}

function systemdUnitObjectPath(unitName: string): string {
  // Mirror systemd's stable bus_label_escape() byte encoding for unit objects.
  let label = "";
  let index = 0;
  for (const byte of new TextEncoder().encode(unitName)) {
    const isAsciiLetter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    const isNoninitialDigit = index > 0 && byte >= 0x30 && byte <= 0x39;
    label += isAsciiLetter || isNoninitialDigit
      ? String.fromCharCode(byte)
      : `_${byte.toString(16).padStart(2, "0")}`;
    index += 1;
  }
  return `${systemdUnitObjectPathPrefix}${label === "" ? "_" : label}`;
}

function parseSystemdSerializedWords(value: string): string[] | undefined {
  const words: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === " " || value[offset] === "\t") offset += 1;
    if (offset >= value.length) break;

    let raw: string;
    let decodeEscapes = true;
    const first = value[offset];
    if (first === '"' || first === "'") {
      const parsed = systemdQuotedWord(value, offset, first);
      if (parsed === undefined) return undefined;
      raw = parsed.raw;
      offset = parsed.nextOffset;
      decodeEscapes = first === '"';
    } else if (first === "$" && value[offset + 1] === "'") {
      const parsed = systemdQuotedWord(value, offset + 1, "'");
      if (parsed === undefined) return undefined;
      raw = parsed.raw;
      offset = parsed.nextOffset;
    } else {
      const start = offset;
      while (offset < value.length && value[offset] !== " " && value[offset] !== "\t") offset += 1;
      raw = value.slice(start, offset);
      if (raw.includes('"') || raw.includes("'")) return undefined;
    }

    if (offset < value.length && value[offset] !== " " && value[offset] !== "\t") return undefined;
    const decoded = decodeEscapes ? decodeSystemdPrintedEscapes(raw) : raw;
    if (decoded === undefined || decoded.includes("\u0000")) return undefined;
    words.push(decoded);
  }
  return words;
}

function decodeSystemdPrintedEscapes(value: string): string | undefined {
  // systemctl serializes string arrays with shell_maybe_quote(), whose
  // double-quoted form additionally escapes shell-significant $ and `.
  return decodeSystemdEscapes(value.replaceAll("\\$", "$").replaceAll("\\`", "`"));
}

function systemdQuotedWord(
  value: string,
  quoteOffset: number,
  quote: '"' | "'",
): { raw: string; nextOffset: number } | undefined {
  let escaped = false;
  for (let offset = quoteOffset + 1; offset < value.length; offset += 1) {
    const character = value[offset];
    if (quote === '"' || value[quoteOffset - 1] === "$") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
    }
    if (character === quote) {
      return { raw: value.slice(quoteOffset + 1, offset), nextOffset: offset + 1 };
    }
  }
  return undefined;
}

interface LaunchdPrintDefinition {
  path: string;
  environment: Readonly<Record<string, string>>;
}

function parseLaunchdPrintDefinition(output: string): LaunchdPrintDefinition | undefined {
  const lines = output.split(/\r?\n/u);
  const paths = lines.flatMap((line) => {
    const match = /^[ \t]*path = (.+)$/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const environmentStarts = lines.flatMap((line, index) => (
    /^[ \t]*environment = \{[ \t]*$/u.test(line) ? [index] : []
  ));
  if (paths.length !== 1 || environmentStarts.length !== 1) return undefined;

  const environment: Record<string, string> = {};
  let closed = false;
  for (let index = (environmentStarts[0] ?? 0) + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^[ \t]*\}[ \t]*$/u.test(line)) {
      closed = true;
      break;
    }
    if (/^[ \t]*$/u.test(line)) continue;
    const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*) => (.*)$/u.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined || Object.hasOwn(environment, key)) return undefined;
    environment[key] = value;
  }
  if (!closed) return undefined;
  return { path: paths[0] ?? "", environment };
}

function launchdServiceIsMissing(result: InstalledNativeServiceDefinitionCommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /could not find (?:specified )?service|service (?:was )?not found/iu.test(output);
}

function recordsEqual(
  first: Readonly<Record<string, string>>,
  second: Readonly<Record<string, string>>,
): boolean {
  const firstEntries = Object.entries(first);
  const secondEntries = Object.entries(second);
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([key, value]) => second[key] === value);
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
