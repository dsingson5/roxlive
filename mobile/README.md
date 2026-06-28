# RoxLive Form Lab — native (Expo) app

A native rep-counter + form analyzer that reuses the web app's **pure TS engine**
(`../src/lib/repForm.ts`, `exercises.ts`, `gait.ts`) but swaps the browser's
MediaPipe-in-WebGL for **on-device pose + a real high-fps camera** — the parts
that detect movement better than a browser:

- **120–240 fps capture** (browser caps at ~30) → sharper bar-speed/tempo, and
  the only path to ground-contact-time / foot-strike.
- **On-device GPU/NNAPI/Core ML** inference → the accurate model runs in real time.
- (Roadmap) **LiDAR/TrueDepth 3D** → fixes the 2D knee-cave/spine limits the web
  engine flags as `low_2d`.

The detection *logic* (rep state machine, form checks, tempo, velocity-loss) is
the **same code** as the web app — Metro shares `../src/lib` via `@engine/*`, so
the two never drift.

> ⚠️ **Status: v0 scaffold.** This was authored without a React Native toolchain
> to test against, so treat the native wiring (frame processor, model, plugin
> versions) as a starting point to validate on the first `eas build` — not a
> guaranteed-clean build. Bring the build/runtime errors back and we'll iterate.

## Architecture

```
Camera frame ─▶ vision-camera frame processor (worklet)
                 ├─ vision-camera-resize-plugin → 192×192 uint8 RGB
                 ├─ react-native-fast-tflite → MoveNet → 17 keypoints
                 └─ runOnJS ─▶ moveNetToLandmarks() → @engine RepFormAnalyzer
                                                       ├─ reps / phase / form
                                                       └─ expo-speech coaching
```

- `src/pose/movenet.ts` — remaps MoveNet's 17 COCO keypoints to the engine's
  BlazePose indices (shoulder 11/12, hip 23/24, knee 25/26, ankle 27/28, …).
- `src/screens/RunnerScreen.tsx` — camera + frame processor + the shared engine + UI.
- `src/coach/speech.ts` — native TTS.

## Prerequisites

- Node 18+, `npm i -g eas-cli`, an Expo account (`eas login`) — **free**, and EAS
  Build runs in the cloud, so **no Mac is needed** to compile iOS.
- For iOS distribution to your own iPhone you need an **Apple Developer account
  ($99/yr)**; EAS handles signing. (Android needs nothing extra.)

## Setup

```bash
cd mobile
npm install
eas init                 # creates the project, fills extra.eas.projectId in app.json
```

### The pose model
`RunnerScreen.tsx` loads MoveNet from a URL (`MOVENET_URL`). **Verify that URL**
(it points at the TF-Hub Lightning/int8 tflite); if it 404s, download a MoveNet
SinglePose Lightning `.tflite`, drop it in `mobile/assets/`, and switch to a
bundled load: `useTensorflowModel(require("../../assets/movenet.tflite"))`
(Metro already bundles `.tflite` — see `metro.config.js`).

## Build & run (no Mac required)

```bash
# Android (fastest to iterate): a dev client APK you sideload
eas build --profile development --platform android

# iOS: a dev client you install via TestFlight / ad-hoc
eas build --profile development --platform ios

# then run the JS over the dev client:
npx expo start --dev-client
```

Scan the QR with the installed dev client. Edit JS/TS and it hot-reloads; only
native changes (new packages, app.json plugins) need a fresh `eas build`.

## Known things to validate on device

1. **Frame-processor wiring** — `react-native-vision-camera` (v4) + `react-native-worklets-core`
   + `react-native-fast-tflite` + `vision-camera-resize-plugin` versions must line
   up with the Expo SDK; if Metro/worklets complain, pin to the versions the
   vision-camera docs recommend for this SDK.
2. **Model I/O shape** — confirm MoveNet output is `[1,1,17,3]` flattened to 51
   floats as `[y,x,score]`; adjust `moveNetToLandmarks` if your model differs.
3. **Aspect ratio** — the resize to 192×192 should center-crop to square (not
   squish) or knee/hip ANGLES distort; use the resize plugin's crop option.
4. **Orientation** — map frame orientation so x/y aren't rotated vs the engine's
   "y increases downward, side-on" assumption.

## Roadmap (port from web, incrementally)

- The full **session runner** (`strengthRunner.ts`) — needs an AsyncStorage/SQLite
  adapter to replace IndexedDB (`strengthHistory.ts`) + an RN HTML parser to
  replace DOMParser (`strengthImport.ts`).
- Skeleton overlay (react-native-svg / Skia), bar-path, voice commands (already
  native via the mic), and LiDAR depth for true-3D form on iPhone Pro.
