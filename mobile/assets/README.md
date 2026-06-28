# Pose model (required before building)

`RunnerScreen.tsx` loads the pose model from `mobile/assets/movenet.tflite` via
`require()`. **That file is not committed** (binaries stay out of git), so you
must drop it here once before the first `eas build` — otherwise Metro will error
with `Unable to resolve "../../assets/movenet.tflite"`.

## Get the model

**MoveNet SinglePose Lightning — INT8 `.tflite`** (the code expects 192×192 uint8
input → 17×3 `[y,x,score]` output):

1. Download from Kaggle Models (the current home of TF-Hub models):
   <https://www.kaggle.com/models/google/movenet/tfLite/singlepose-lightning-tflite-int8>
   (free Kaggle account → "Download" the `.tflite`). Or grab a known-good mirror.
2. Rename it to **`movenet.tflite`** and place it in this folder:
   `mobile/assets/movenet.tflite`.

That's it — Metro bundles `.tflite` (see `metro.config.js`), and `app.json` has
the `react-native-fast-tflite` config plugin so the native TFLite framework +
Core ML delegate are linked.

## Swapping models

- **Thunder** (slower, more accurate) has the same I/O shape — drop it in as
  `movenet.tflite` and it just works.
- A **float16** model expects `dataType: "float32"` input — change the `resize(...)`
  call in `RunnerScreen.tsx` accordingly.
- A **MultiPose** model has a different output shape — `src/pose/movenet.ts` would
  need updating.
