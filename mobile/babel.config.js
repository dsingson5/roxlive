module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // worklets for vision-camera frame processors (must precede reanimated)
      ["react-native-worklets-core/plugin"],
      // reanimated plugin MUST be last
      "react-native-reanimated/plugin",
    ],
  };
};
