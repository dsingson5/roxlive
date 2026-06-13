# RoxLive — Real-Time Multi-Sensor Workout Analyzer & HYROX Guide

**Live: https://dsingson5.github.io/roxlive/** (Chrome/Edge for sensor pairing)

A browser-based sports-science cockpit that turns a Bluetooth heart-rate strap
into a live physiology lab. Built directly from the recommendations in
*"Real-Time HYROX Workout Analysis"* — it implements the **Web Bluetooth →
in-browser analytics → live dashboard** path the report identifies as the
pragmatic "no-phone-app" architecture.

![RoxLive](public/icon.svg)

## What it does

Connects to any standard BLE **Heart Rate Service (0x180D)** sensor — Polar H10,
Garmin HRM-Pro Plus, or a Whoop in *HR-Broadcast* mode — reads instantaneous HR
**and beat-to-beat R-R intervals**, and computes, in real time:

| Metric | What it tells you | Source |
| --- | --- | --- |
| **DFA-α1** | Internal-load intensity vs LT1 (≈0.75) / LT2 (≈0.50) thresholds | R-R, detrended fluctuation analysis, 2-min rolling window |
| **HR-zone segmentation** | Time in each of 5 zones, anchored to your Max HR | HR |
| **Aerobic decoupling** | Pa:HR drift — aerobic durability / fatigue | speed ÷ HR, first vs second half |
| **Breathing rate** | Respiration from RSA, no chest band needed | R-R spectral analysis (0.13–0.7 Hz) |
| **HRV** | RMSSD / SDNN vagal tone | R-R |
| **Work/rest intervals** | Automatic rep detection | HR + speed state machine |
| **R-R artifact rate** | The report's HRM-Pro-Plus vs Polar-H10 go/no-go gate | local-median R-R cleaner |

Plus a full **HYROX race guide**: all 8 stations with pacing, technique cues,
mistakes to avoid, transition advice, and Open/Pro targets — with the current
station's coaching surfaced live as a simulated race progresses.

## Three modes

- **Analyzer** — the raw real-time lab: HR, DFA-α1, decoupling, breathing, HRV.
- **HYROX** — the 8-run / 8-station race guide with live station coaching.
- **Workout** — guided interval sessions from *your* plan (below).

## Guided Workout: photo → coached intervals

Snap a photo of today's workout (a whiteboard, notebook, coach's plan, or phone
screenshot) and **Claude vision turns it into structured, timed intervals** with
target HR zones — expanding repeats, converting durations, and reading off zones
or explicit HR ranges. You then edit it freely before starting (reorder,
retime, change targets, add notes), or pick a built-in sample.

**Nothing starts until you press START** — connect your strap (or Demo), watch
your live HR settle, then hit the big START button when you're ready. That
press begins the lead-in countdown and unlocks the voice coach.

During the session:

- A **voice coach** (any installed system voice — male/female/your choice, with
  adjustable speed & pitch) announces the **start of each interval and its
  target**, the **halfway** point, **"ten seconds"**, and a **5-4-3-2-1**
  countdown into the next interval, plus a lead-in "get ready" countdown.
- A live **target-vs-actual meter** shows whether your HR is **on target**,
  **below** (push), or **above** (ease), and tracks **% time in target** per
  interval and overall — summarised at the end.
- The timer and voice cues are **background-resilient** (they keep running if
  you switch tabs/apps mid-session, so you can change your music).

The photo parser calls the Claude Messages API directly from the browser
(`anthropic-dangerous-direct-browser-access`). Your API key is stored only in
your browser's localStorage and sent solely to `api.anthropic.com`. Default
vision model is Sonnet 4.6 (fast, great value); Opus 4.8 and Haiku 4.5 are
selectable. No key needed for the samples or the hand editor.

## Run it

```bash
npm install
npm run dev      # http://localhost:5180
```

Open in **Chrome or Edge** (desktop or Android) for live sensor pairing —
Web Bluetooth is required and isn't available in Safari. Click **Demo** to watch
a physiologically-modelled HYROX race drive every metric with no hardware.

```bash
npm run build    # type-check + production bundle to docs/ (GitHub Pages)
npm run preview  # serve the production build
```

Deployment: GitHub Pages serves `main:/docs` — rebuild and push to update the
live site.

## Sources: real sensor first, simulator opt-in

**Connect** pairs a real BLE strap and that data is always used as-is. **Simulate**
is an explicit, clearly-labelled choice (a "SIM" badge shows on the device chip)
for trying the app with no hardware — it never overrides a connected sensor.
Beyond HR + R-R, the app also reads **running cadence** (RSC 0x1814) and
**body/core temperature** (Health Thermometer 0x1809) from a sensor when
available, and shows pace (from GPS) + cadence + temperature live. The
simulator produces all of these too.

## Countdown coaching

In the final **3·2·1 seconds** of any interval (workout) or segment (HYROX) a
huge on-screen countdown appears with a spoken cue, so you know a transition is
coming without looking down.

## History

Every finished session is saved on-device and listed in the **History** panel
(clock icon, top bar): mode, date, duration, avg/max HR, zone split, adherence,
and an HR trace. Open any past session for the full summary — including .FIT
re-export.

## Strava (optional)

Post finished sessions straight to Strava — **only when you tap "Post to
Strava" and confirm**. Because the site is static, the OAuth secret lives in a
tiny free Cloudflare Worker you deploy once; tokens stay in your browser. Setup
(Strava app + worker, ~10 min) is in [strava/README.md](strava/README.md), then
**⚙ Settings → Strava → Connect**.

## Export

Every finished session can be exported as a **Garmin .FIT activity file**
(1 Hz heart rate + cadence records, one lap per interval/station, session
totals) — upload it to Garmin Connect, Strava, TrainingPeaks, intervals.icu,
etc. The encoder is dependency-free ([src/lib/fit.ts](src/lib/fit.ts)) and
validated by [tools/verify-fit.mjs](tools/verify-fit.mjs).

## How it maps to the report

- **Sensors over BLE, not the Whoop API.** The Whoop cloud API isn't real-time;
  this reads the live BLE HR broadcast like any other strap. ANT-only running
  dynamics are out of scope for a browser app (as the report notes).
- **DFA-α1 is the headline metric.** Implemented as short-term DFA (box sizes
  4–16) over artifact-cleaned R-R. Validated in-app against white-noise (α≈0.5),
  pink-noise (α≈1.0) and Brownian (α≈1.5) references — see the dev console.
- **Artifact rate is a first-class readout**, because the report makes it the
  deciding factor between the HRM-Pro Plus and a Polar H10 for clean R-R.
- **Web dashboard on desktop Chrome** is the chosen platform — the report's
  explicit "no-phone-app" fallback. GPS pace (for Pa:HR) is pulled from the
  browser Geolocation API when available.

## Stack

React 19 · TypeScript · Vite 6 · Tailwind 4 · Motion · custom SVG telemetry
charts. No analytics backend — everything runs client-side in the browser.

## Caveats (from the report, honoured here)

- DFA-α1 thresholds (0.75 / 0.50) are **population defaults** — pair them with
  your own lactate or ramp test for personal LT1/LT2 anchors.
- HRM-Pro Plus R-R reliability over BLE is variable in the field; the live
  **artifact %** readout is there so you can make the Polar-H10 call yourself.
- Not a medical device.
