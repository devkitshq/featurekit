/**
 * Metro, told about the monorepo above it.
 *
 * This example lives inside the featurekit repository and depends on
 * `featurekit-client` through a `file:` link, so the package resolves to a
 * symlink pointing at `packages/client`. Metro will not watch, or resolve out
 * of, a directory above the project root unless it is told to — so a rebuild of
 * the SDK would otherwise be invisible here.
 *
 * In your own app none of this file is needed: you `npm i featurekit-client`
 * and the default Expo config resolves it like any other dependency.
 */

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];

// Both node_modules trees, and only those: hierarchical lookup is off so a
// stray package higher up the disk cannot resolve by accident.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// The SDK is ESM and publishes through `exports`, as does `expo/fetch`.
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
