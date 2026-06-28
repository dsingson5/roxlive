/**
 * Native Form Lab runner (single-set MVP).
 *
 * Camera frame → MoveNet (on-device, GPU/NNAPI) in a vision-camera frame
 * processor → keypoints handed to JS → mapped to the SHARED engine's Landmarks
 * → RepFormAnalyzer (../../src/lib/repForm.ts, byte-for-byte the web logic) →
 * live rep count + form cues + spoken coaching. This is the piece that benefits
 * from native: real high-fps capture + on-device acceleration vs the browser.
 *
 * NOTE: untested in this environment (no RN toolchain here) — expect to iterate
 * on the frame-processor / model wiring during the first `eas build` on device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useFrameProcessor,
} from "react-native-vision-camera";
import { useResizePlugin } from "vision-camera-resize-plugin";
import { useTensorflowModel } from "react-native-fast-tflite";
import { Worklets } from "react-native-worklets-core";

import { RepFormAnalyzer, type RepFormSnapshot, type SetReport } from "@engine/repForm";
import { EXERCISES, getExercise } from "@engine/exercises";
import { moveNetToLandmarks, poseQuality } from "../pose/movenet";
import { say, setVoiceEnabled } from "../coach/speech";

const VOLT = "#d8ff3a";
const INK = "#f2f4f6";
const DIM = "#9aa3b2";
const FAINT = "#5d6675";
const AMBER = "#ffb02e";
const RED = "#ff4d4d";

export function RunnerScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  // pick a 60fps-capable format (the whole point of going native); falls back to 30
  const format = useCameraFormat(device, [{ fps: 60 }]);
  // MoveNet SinglePose Lightning (int8), bundled. See mobile/assets/README.md to add it.
  const model = useTensorflowModel(require("../../assets/movenet.tflite"));
  const { resize } = useResizePlugin();

  const [exId, setExId] = useState("back_squat");
  const [running, setRunning] = useState(false);
  const [snap, setSnap] = useState<RepFormSnapshot | null>(null);
  const [report, setReport] = useState<SetReport | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);

  const repRef = useRef<RepFormAnalyzer | null>(null);
  const spokeRef = useRef({ reps: 0, cue: "", t: 0 });
  const lastHudRef = useRef(0);

  useEffect(() => { requestPermission(); }, [requestPermission]);
  useEffect(() => { setVoiceEnabled(voiceOn); }, [voiceOn]);

  // JS-thread handler: runs the SHARED engine on the mapped landmarks.
  const onPose = useMemo(
    () =>
      Worklets.createRunOnJS((kp: number[], ts: number) => {
        const rep = repRef.current;
        if (!rep) return;
        const lm = moveNetToLandmarks(kp);
        rep.push(ts, lm);
        const now = Date.now();
        if (now - lastHudRef.current < 90) return; // ~11 Hz HUD
        lastHudRef.current = now;
        const s = rep.snapshot();
        setSnap(s);
        // count along + correct (mirrors the web loop)
        const sp = spokeRef.current;
        if (s.reps !== sp.reps) {
          sp.reps = s.reps;
          const bad = s.lastRep?.faults.find((f) => f.severity !== "info");
          if (bad && poseQuality(lm) >= 0.4) say(`${s.reps}. ${bad.cue}.`, { interrupt: true });
          else say(String(s.reps), { interrupt: true });
        } else {
          const top = s.liveFaults.find((f) => f.severity !== "info");
          if (top && s.quality >= 0.4 && top.cue !== sp.cue && now - sp.t > 2800) {
            sp.cue = top.cue; sp.t = now; say(top.cue);
          }
        }
      }),
    []
  );

  const frameProcessor = useFrameProcessor(
    (frame) => {
      "worklet";
      if (model.state !== "loaded") return;
      const resized = resize(frame, {
        scale: { width: 192, height: 192 },
        pixelFormat: "rgb",
        dataType: "uint8",
      });
      // fast-tflite wants an ArrayBuffer input (not the TypedArray's possibly-offset buffer)
      const input = resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength);
      const outputs = model.model.runSync([input]);
      // output is the 17×3 [y,x,score] keypoints; wrap defensively to a Float32Array
      const o = outputs[0] as unknown;
      const f = o instanceof Float32Array ? o : new Float32Array(o as ArrayBuffer);
      const arr: number[] = [];
      for (let i = 0; i < f.length; i++) arr.push(f[i]);
      onPose(arr, frame.timestamp);
    },
    [model, resize, onPose]
  );

  const start = useCallback(() => {
    const ex = getExercise(exId) ?? getExercise("back_squat")!;
    repRef.current = new RepFormAnalyzer(ex);
    spokeRef.current = { reps: 0, cue: "", t: 0 };
    setSnap(null);
    setReport(null);
    setRunning(true);
  }, [exId]);

  const stop = useCallback(() => {
    setRunning(false);
    const r = repRef.current?.report() ?? null;
    setReport(r);
    if (r && r.reps > 0) say(`Set complete. ${r.reps} reps.`, { interrupt: true });
    repRef.current = null;
  }, []);

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Camera permission is needed to count reps.</Text>
        <Pressable style={styles.btn} onPress={requestPermission}><Text style={styles.btnText}>Grant camera access</Text></Pressable>
      </View>
    );
  }
  if (device == null) return <View style={styles.center}><Text style={styles.dim}>No camera device found.</Text></View>;

  const ex = getExercise(exId);
  const warn = (snap?.liveFaults ?? []).filter((f) => f.severity !== "info");

  return (
    <View style={styles.root}>
      {/* small inset camera window */}
      <View style={styles.cameraWrap}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={running}
          frameProcessor={running ? frameProcessor : undefined}
          pixelFormat="yuv"
          format={format}
          fps={format ? Math.min(60, format.maxFps) : 30}
        />
        {model.state !== "loaded" && (
          <View style={styles.overlay}><Text style={styles.faint}>{model.state === "loading" ? "Loading pose model…" : "Model error — see mobile/assets/README.md"}</Text></View>
        )}
      </View>

      <ScrollView style={styles.panel} contentContainerStyle={{ paddingBottom: 32 }}>
        {!running && !report && (
          <>
            <Text style={styles.title}>Form Lab — single set</Text>
            <Text style={styles.faint}>Pick a movement, frame yourself side-on, then Start.</Text>
            <View style={styles.exGrid}>
              {EXERCISES.map((e) => (
                <Pressable key={e.id} onPress={() => setExId(e.id)} style={[styles.chip, exId === e.id && styles.chipOn]}>
                  <Text style={[styles.chipText, exId === e.id && styles.chipTextOn]}>{e.name}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.btn} onPress={start}><Text style={styles.btnText}>▶ Start</Text></Pressable>
          </>
        )}

        {running && (
          <>
            <Text style={styles.cardTitle}>{ex?.name} · reps</Text>
            <View style={styles.repRow}>
              <Text style={styles.repBig}>{snap?.reps ?? 0}</Text>
              <Text style={styles.dim}>{snap ? phaseLabel(snap.phase) : "get set"}</Text>
            </View>
            <Text style={styles.faint}>{snap && snap.quality < 0.5 ? "Measuring… keep your whole body in frame" : "Counting reps + checking form live."}</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Form — live</Text>
              {warn.length === 0 ? (
                <Text style={{ color: "#3dffb5" }}>✓ Looking clean — keep it up.</Text>
              ) : warn.slice(0, 2).map((f) => (
                <Text key={f.code} style={{ color: f.severity === "fault" ? RED : AMBER, marginTop: 4 }}>
                  {f.fault} — <Text style={styles.dim}>{f.cue}</Text>
                </Text>
              ))}
            </View>
            <Pressable style={[styles.btn, styles.btnStop]} onPress={stop}><Text style={[styles.btnText, { color: RED }]}>■ Stop &amp; review</Text></Pressable>
            <Pressable onPress={() => setVoiceOn((v) => !v)}><Text style={styles.faint}>🔊 Voice {voiceOn ? "on" : "off"}</Text></Pressable>
          </>
        )}

        {report && (
          <>
            <Text style={styles.cardTitle}>{ex?.name} · set summary</Text>
            <View style={styles.repRow}>
              <Text style={styles.repBig}>{report.reps}</Text>
              <Text style={styles.dim}>reps · {report.cleanReps}/{report.reps} clean</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Form flags</Text>
              {report.faults.length === 0 ? (
                <Text style={{ color: "#3dffb5" }}>✓ No form flags — clean set.</Text>
              ) : report.faults.map((f) => (
                <Text key={f.code} style={{ color: INK, marginTop: 4 }}>{f.fault} · {f.reps}/{report.reps} reps — <Text style={styles.dim}>{f.cue}</Text></Text>
              ))}
            </View>
            <Pressable style={styles.btn} onPress={() => setReport(null)}><Text style={styles.btnText}>New set</Text></Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function phaseLabel(p: RepFormSnapshot["phase"]): string {
  return p === "descending" ? "down" : p === "ascending" ? "up" : p;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#07080a" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#07080a", padding: 24 },
  cameraWrap: { aspectRatio: 16 / 9, margin: 12, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.5)" },
  panel: { flex: 1, paddingHorizontal: 16 },
  title: { color: INK, fontSize: 20, fontWeight: "700", marginBottom: 4 },
  cardTitle: { color: FAINT, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6, marginTop: 8 },
  repRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  repBig: { color: VOLT, fontSize: 72, fontWeight: "800", lineHeight: 76 },
  dim: { color: DIM },
  faint: { color: FAINT, marginTop: 4 },
  card: { backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 14, padding: 14, marginTop: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  exGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  chipOn: { backgroundColor: VOLT, borderColor: VOLT },
  chipText: { color: DIM, fontSize: 13 },
  chipTextOn: { color: "#0b0c06", fontWeight: "700" },
  btn: { backgroundColor: VOLT, borderRadius: 14, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  btnStop: { backgroundColor: "transparent", borderWidth: 1, borderColor: "rgba(255,77,77,0.4)" },
  btnText: { color: "#0b0c06", fontWeight: "700", fontSize: 15 },
});
