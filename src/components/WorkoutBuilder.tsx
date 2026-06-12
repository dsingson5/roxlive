import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AthleteProfile,
  TargetType,
  VoiceSettings,
  WorkoutInterval,
  WorkoutIntervalKind,
  WorkoutPlan,
} from "../types";
import {
  KIND_LABEL,
  newInterval,
  planDurationSec,
  samplePlans,
  adoptParsed,
} from "../lib/workout";
import { VISION_MODELS, fileToBase64, parseWorkoutImage } from "../lib/vision";
import { VoiceCoach, guessGender, loadVoices, speechSupported } from "../lib/voice";
import { fmtClock } from "../lib/format";

const KINDS: WorkoutIntervalKind[] = ["warmup", "work", "active", "rest", "cooldown"];
const TARGET_TYPES: { v: TargetType; label: string }[] = [
  { v: "zone", label: "HR Zone" },
  { v: "hr", label: "HR Range" },
  { v: "pace", label: "Pace" },
  { v: "rpe", label: "RPE" },
  { v: "none", label: "By feel" },
];

export function WorkoutBuilder({
  open,
  onClose,
  initialPlan,
  profile,
  voice,
  onVoiceChange,
  apiKey,
  onApiKeyChange,
  model,
  onModelChange,
  onSave,
  onStart,
}: {
  open: boolean;
  onClose: () => void;
  initialPlan: WorkoutPlan | null;
  profile: AthleteProfile;
  voice: VoiceSettings;
  onVoiceChange: (v: VoiceSettings) => void;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  model: string;
  onModelChange: (m: string) => void;
  onSave: (plan: WorkoutPlan) => void;
  onStart: (plan: WorkoutPlan) => void;
}) {
  const [draft, setDraft] = useState<WorkoutPlan>(() => initialPlan ?? emptyPlan());
  const [preview, setPreview] = useState<string | null>(null);
  const [img, setImg] = useState<{ base64: string; mediaType: string } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const coachRef = useRef(new VoiceCoach(voice));

  useEffect(() => {
    if (open) setDraft(initialPlan ?? emptyPlan());
  }, [open, initialPlan]);

  useEffect(() => {
    coachRef.current.setSettings(voice);
  }, [voice]);

  useEffect(() => {
    if (open && speechSupported()) loadVoices().then(setVoices);
  }, [open]);

  const total = useMemo(() => planDurationSec(draft), [draft]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setPreview(URL.createObjectURL(file));
    try {
      const enc = await fileToBase64(file);
      setImg(enc);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const analyze = async () => {
    if (!img || !apiKey.trim()) return;
    setParsing(true);
    setParseError(null);
    const res = await parseWorkoutImage({
      base64: img.base64,
      mediaType: img.mediaType,
      apiKey,
      model,
      maxHr: profile.maxHr,
    });
    setParsing(false);
    if (res.ok && res.workout) {
      setDraft(adoptParsed(res.workout, "photo"));
    } else {
      setParseError(res.error || "Could not read the workout.");
    }
  };

  const patch = (id: string, fn: (iv: WorkoutInterval) => WorkoutInterval) =>
    setDraft((d) => ({ ...d, intervals: d.intervals.map((iv) => (iv.id === id ? fn(iv) : iv)) }));

  const move = (idx: number, dir: -1 | 1) =>
    setDraft((d) => {
      const arr = [...d.intervals];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return d;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...d, intervals: arr };
    });

  const del = (id: string) => setDraft((d) => ({ ...d, intervals: d.intervals.filter((iv) => iv.id !== id) }));
  const dup = (idx: number) =>
    setDraft((d) => {
      const arr = [...d.intervals];
      arr.splice(idx + 1, 0, newInterval({ ...arr[idx], name: arr[idx].name }));
      return { ...d, intervals: arr };
    });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-4 pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="card pointer-events-auto w-[min(820px,97vw)] max-h-[94vh] overflow-y-auto p-5 sm:p-6"
              initial={{ scale: 0.95, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 16 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
            >
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-[var(--font-display)] text-2xl font-bold">Today's Workout</h2>
                <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
              </div>
              <p className="text-[12px] text-[var(--color-ink-dim)] mb-5">Snap a photo of your plan, pick a sample, or build it by hand — then tune the voice coach and start.</p>

              {/* ---- Photo import ---- */}
              <Section title="1 · Import from a photo">
                <div className="grid sm:grid-cols-[140px_1fr] gap-4">
                  <div className="rounded-xl border border-dashed border-[var(--color-line2)] bg-white/[0.02] grid place-items-center overflow-hidden aspect-square">
                    {preview ? (
                      <img src={preview} alt="workout" className="w-full h-full object-cover" />
                    ) : (
                      <div className="text-center text-[var(--color-ink-faint)] text-[11px] px-2">No image yet</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <button onClick={() => uploadRef.current?.click()} className="btn-ghost flex-1 h-9 text-[13px]">Upload photo</button>
                      <button onClick={() => cameraRef.current?.click()} className="btn-ghost flex-1 h-9 text-[13px]">Take photo</button>
                    </div>
                    <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                    <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => onApiKeyChange(e.target.value)}
                        placeholder="Anthropic API key (sk-ant-…)"
                        className="inp flex-1"
                      />
                      <select value={model} onChange={(e) => onModelChange(e.target.value)} className="inp w-[160px]">
                        {VISION_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                    <button onClick={analyze} disabled={!img || !apiKey.trim() || parsing} className="btn-volt h-9 text-[13px] disabled:opacity-50">
                      {parsing ? "Reading your workout…" : "✨ Analyze photo with Claude"}
                    </button>
                    {parseError && <div className="text-[11px] text-[var(--color-red)]">{parseError}</div>}
                    <div className="text-[10px] text-[var(--color-ink-faint)] leading-relaxed">
                      Your key is stored only in this browser and sent directly to api.anthropic.com. No key? Use a sample or build it by hand below.
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <span className="text-[10px] tracking-wide text-[var(--color-ink-faint)] self-center">SAMPLES:</span>
                  {samplePlans().map((s) => (
                    <button key={s.id} onClick={() => setDraft(s)} className="btn-ghost h-7 px-3 text-[11px]">{s.title}</button>
                  ))}
                </div>
              </Section>

              {/* ---- Editor ---- */}
              <Section title="2 · Review & edit">
                <div className="flex items-center gap-3 mb-3">
                  <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} className="inp flex-1 font-semibold" placeholder="Workout title" />
                  <div className="mono text-[12px] text-[var(--color-ink-dim)] shrink-0">{fmtClock(total)} · {draft.intervals.length} steps</div>
                </div>

                <div className="space-y-2">
                  {draft.intervals.map((iv, idx) => (
                    <IntervalRow
                      key={iv.id}
                      iv={iv}
                      idx={idx}
                      count={draft.intervals.length}
                      onChange={(fn) => patch(iv.id, fn)}
                      onMove={(dir) => move(idx, dir)}
                      onDup={() => dup(idx)}
                      onDel={() => del(iv.id)}
                    />
                  ))}
                </div>
                <button onClick={() => setDraft((d) => ({ ...d, intervals: [...d.intervals, newInterval()] }))} className="btn-ghost w-full h-9 mt-2 text-[13px]">+ Add interval</button>
              </Section>

              {/* ---- Voice ---- */}
              <Section title="3 · Voice coach">
                <VoicePanel voice={voice} voices={voices} onChange={onVoiceChange} onTest={() => { coachRef.current.setSettings(voice); coachRef.current.say("Three. Two. One. Go. This is your workout voice.", { interrupt: true }); coachRef.current.beep(880, 120); }} />
              </Section>

              {/* ---- Footer ---- */}
              <div className="flex gap-2 mt-6">
                <button onClick={() => { onStart(draft); }} disabled={draft.intervals.length === 0} className="btn-volt flex-1 h-11 text-sm disabled:opacity-50">✓ Use this workout</button>
                <button onClick={() => { onSave(draft); onClose(); }} className="btn-ghost px-5 h-11 text-sm">Save</button>
                <button onClick={onClose} className="btn-ghost px-5 h-11 text-sm">Cancel</button>
              </div>
              <p className="text-[10px] text-[var(--color-ink-faint)] mt-2 text-center">Nothing starts yet — you'll get a big START button on the dashboard when you're ready.</p>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function emptyPlan(): WorkoutPlan {
  return {
    id: `plan-${Math.round(performance.now())}`,
    title: "My workout",
    source: "manual",
    createdAt: Math.round(performance.timeOrigin + performance.now()),
    intervals: [newInterval({ name: "Warm-up", kind: "warmup", durationSec: 300, target: { type: "zone", zone: 2 } })],
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="card-title mb-3">{title}</div>
      {children}
    </div>
  );
}

function IntervalRow({
  iv,
  idx,
  count,
  onChange,
  onMove,
  onDup,
  onDel,
}: {
  iv: WorkoutInterval;
  idx: number;
  count: number;
  onChange: (fn: (iv: WorkoutInterval) => WorkoutInterval) => void;
  onMove: (dir: -1 | 1) => void;
  onDup: () => void;
  onDel: () => void;
}) {
  const min = Math.floor(iv.durationSec / 60);
  const sec = iv.durationSec % 60;
  const setDur = (m: number, s: number) => onChange((x) => ({ ...x, durationSec: Math.max(1, m * 60 + s) }));

  return (
    <div className="rounded-xl bg-white/[0.025] border border-[var(--color-line)] p-2.5">
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] text-[var(--color-ink-faint)] w-5 text-center">{idx + 1}</span>
        <input value={iv.name} onChange={(e) => onChange((x) => ({ ...x, name: e.target.value }))} className="inp flex-1 h-8" />
        <select value={iv.kind} onChange={(e) => onChange((x) => ({ ...x, kind: e.target.value as WorkoutIntervalKind }))} className="inp w-[110px] h-8">
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <div className="flex items-center gap-1 shrink-0">
          <input type="number" min={0} value={min} onChange={(e) => setDur(Number(e.target.value) || 0, sec)} className="inp w-12 h-8 text-center" />
          <span className="text-[var(--color-ink-faint)] text-xs">:</span>
          <input type="number" min={0} max={59} value={sec} onChange={(e) => setDur(min, Math.min(59, Number(e.target.value) || 0))} className="inp w-12 h-8 text-center" />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconBtn onClick={() => onMove(-1)} disabled={idx === 0} title="Move up">↑</IconBtn>
          <IconBtn onClick={() => onMove(1)} disabled={idx === count - 1} title="Move down">↓</IconBtn>
          <IconBtn onClick={onDup} title="Duplicate">⧉</IconBtn>
          <IconBtn onClick={onDel} title="Delete" danger>×</IconBtn>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 pl-7">
        <select value={iv.target.type} onChange={(e) => onChange((x) => ({ ...x, target: { ...x.target, type: e.target.value as TargetType } }))} className="inp w-[110px] h-8">
          {TARGET_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        {iv.target.type === "zone" && (
          <select value={iv.target.zone ?? 3} onChange={(e) => onChange((x) => ({ ...x, target: { ...x.target, zone: Number(e.target.value) } }))} className="inp w-[90px] h-8">
            {[1, 2, 3, 4, 5].map((z) => <option key={z} value={z}>Zone {z}</option>)}
          </select>
        )}
        {iv.target.type === "hr" && (
          <div className="flex items-center gap-1">
            <input type="number" value={iv.target.hrLow ?? 140} onChange={(e) => onChange((x) => ({ ...x, target: { ...x.target, hrLow: Number(e.target.value) } }))} className="inp w-16 h-8 text-center" />
            <span className="text-[var(--color-ink-faint)] text-xs">–</span>
            <input type="number" value={iv.target.hrHigh ?? 155} onChange={(e) => onChange((x) => ({ ...x, target: { ...x.target, hrHigh: Number(e.target.value) } }))} className="inp w-16 h-8 text-center" />
            <span className="text-[10px] text-[var(--color-ink-faint)]">bpm</span>
          </div>
        )}
        <input
          value={iv.target.label ?? ""}
          onChange={(e) => onChange((x) => ({ ...x, target: { ...x.target, label: e.target.value } }))}
          placeholder={iv.target.type === "pace" ? "e.g. 5:30 /km" : iv.target.type === "rpe" ? "e.g. RPE 7" : "label (optional)"}
          className="inp flex-1 h-8"
        />
      </div>
      {(iv.notes !== undefined || iv.target.type === "none") && (
        <div className="pl-7 mt-2">
          <input value={iv.notes ?? ""} onChange={(e) => onChange((x) => ({ ...x, notes: e.target.value }))} placeholder="Notes / reps / load (optional)" className="inp h-8 text-[12px]" />
        </div>
      )}
    </div>
  );
}

function IconBtn({ children, onClick, disabled, title, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-7 h-8 grid place-items-center rounded-md text-[13px] transition-colors disabled:opacity-30 hover:bg-white/5"
      style={{ color: danger ? "var(--color-red)" : "var(--color-ink-dim)" }}
    >
      {children}
    </button>
  );
}

function VoicePanel({
  voice,
  voices,
  onChange,
  onTest,
}: {
  voice: VoiceSettings;
  voices: SpeechSynthesisVoice[];
  onChange: (v: VoiceSettings) => void;
  onTest: () => void;
}) {
  const set = <K extends keyof VoiceSettings>(k: K, val: VoiceSettings[K]) => onChange({ ...voice, [k]: val });
  const english = voices.filter((v) => /^en/i.test(v.lang));
  const others = voices.filter((v) => !/^en/i.test(v.lang));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-ink-dim)]">
          <input type="checkbox" checked={voice.enabled} onChange={(e) => set("enabled", e.target.checked)} className="accent-[var(--color-volt)] w-4 h-4" />
          Spoken cues (start · halfway · 10s · 5-4-3-2-1)
        </label>
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-ink-dim)]">
          <input type="checkbox" checked={voice.beeps} onChange={(e) => set("beeps", e.target.checked)} className="accent-[var(--color-volt)] w-4 h-4" />
          Beeps
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[10px] tracking-[0.12em] uppercase text-[var(--color-ink-faint)]">Voice</span>
          <select value={voice.voiceURI ?? ""} onChange={(e) => set("voiceURI", e.target.value || null)} className="inp mt-1">
            <option value="">Browser default</option>
            {english.length > 0 && (
              <optgroup label="English">
                {english.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {gLabel(v)} · {v.lang}</option>)}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Other languages">
                {others.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {gLabel(v)} · {v.lang}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] tracking-[0.12em] uppercase text-[var(--color-ink-faint)]">Lead-in countdown</span>
          <select value={voice.leadInSec} onChange={(e) => set("leadInSec", Number(e.target.value))} className="inp mt-1">
            {[5, 8, 10, 15].map((s) => <option key={s} value={s}>{s} seconds</option>)}
          </select>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Slider label={`Speed · ${voice.rate.toFixed(2)}×`} min={0.6} max={1.5} step={0.05} value={voice.rate} onChange={(v) => set("rate", v)} />
        <Slider label={`Pitch · ${voice.pitch.toFixed(2)}`} min={0.6} max={1.6} step={0.05} value={voice.pitch} onChange={(v) => set("pitch", v)} />
      </div>

      <button onClick={onTest} className="btn-ghost h-9 px-4 text-[13px]">🔊 Test voice</button>
      {!speechSupported() && <div className="text-[11px] text-[var(--color-amber)]">This browser has no speech synthesis — cues will be visual only.</div>}
    </div>
  );
}

function gLabel(v: SpeechSynthesisVoice): string {
  const g = guessGender(v);
  return g === "male" ? "♂" : g === "female" ? "♀" : "voice";
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-[0.12em] uppercase text-[var(--color-ink-faint)]">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full mt-2 accent-[var(--color-volt)]" />
    </label>
  );
}
