/**
 * Pi packages PI WEB may install automatically for users out of the box (see
 * the `relay-pi-package-autoinstall` relay). Identity is the package's own
 * declared `name` (its `package.json` "name" field), not the install-source
 * string used to configure it: a locally shipped package is configured by
 * filesystem path today, which is not a stable identity to match against.
 */
export interface KnownAutoInstallablePiPackage {
  /** The package's own declared `name`, matched via {@link resolveDeclaredPiPackageName}. */
  id: string;
  /**
   * Path segments, relative to the running `@jmfederico/pi-web` package root
   * (see `defaultPluginRoots`/`bundledPluginRoot` in `piWebPluginCatalog.ts`
   * for the equivalent resolution), to this package's shipped local
   * directory. Used as the install source when auto-installing it.
   */
  shippedPathSegments: readonly string[];
}

export const KNOWN_AUTO_INSTALLABLE_PI_PACKAGES: readonly KnownAutoInstallablePiPackage[] = [
  { id: "@jmfederico/pi-relay", shippedPathSegments: ["dist", "pi-packages", "relays"] },
];

export const KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS: readonly string[] = KNOWN_AUTO_INSTALLABLE_PI_PACKAGES.map((known) => known.id);

export function isKnownAutoInstallablePiPackageId(id: string): boolean {
  return KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS.includes(id);
}
