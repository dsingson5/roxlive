// Metro config: bundle the native app from mobile/ while SHARING the web app's
// pure TS engine (../src/lib/{repForm,exercises,gait}.ts) so detection logic
// stays identical across web + native. Also lets Metro bundle .tflite models.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, ".."); // the web repo root (has src/lib)

const config = getDefaultConfig(projectRoot);

// watch the repo root so imports of ../src/lib resolve + hot-reload
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// bundle TFLite model files as assets
config.resolver.assetExts.push("tflite");

module.exports = config;
