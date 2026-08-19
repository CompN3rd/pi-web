/**
 * Pi packages PI WEB may install automatically for users out of the box (see
 * the `relay-pi-package-autoinstall` relay). Identity is the package's own
 * declared `name` (its `package.json` "name" field), not the install-source
 * string used to configure it: a locally shipped package is configured by
 * filesystem path today, which is not a stable identity to match against.
 */
export const KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS: readonly string[] = ["@jmfederico/pi-relay"];

export function isKnownAutoInstallablePiPackageId(id: string): boolean {
  return KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS.includes(id);
}
