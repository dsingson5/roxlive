import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { AthleteProfile } from "../types";
import { zoneBounds } from "../lib/zones";
import { VISION_MODELS } from "../lib/vision";
import type { StravaConfig } from "../lib/strava";
import type { SyncConfig } from "../lib/sync";

export function SettingsDrawer({
  open,
  profile,
  apiKey,
  onApiKeyChange,
  model,
  onModelChange,
  strava,
  sync,
  onClose,
  onSave,
}: {
  open: boolean;
  profile: AthleteProfile;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  model: string;
  onModelChange: (m: string) => void;
  strava: {
    config: StravaConfig;
    connected: boolean;
    athlete: string | null;
    onSaveConfig: (c: StravaConfig) => void;
    onConnect: () => void;
    onDisconnect: () => void;
  };
  sync: {
    config: SyncConfig;
    user: string;
    busy: boolean;
    onSaveConfig: (c: SyncConfig) => void;
    onSyncNow: () => void;
  };
  onClose: () => void;
  onSave: (p: AthleteProfile) => void;
}) {
  const [draft, setDraft] = useState<AthleteProfile>(profile);

  // keep draft in sync when reopened
  const set = <K extends keyof AthleteProfile>(k: K, v: AthleteProfile[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const bounds = zoneBounds(draft);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            className="fixed right-0 top-0 bottom-0 z-50 w-[min(420px,92vw)] bg-[var(--color-bg2)] border-l border-[var(--color-line2)] p-6 overflow-y-auto"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-[var(--font-display)] text-lg font-semibold">Athlete Profile</h2>
              <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
            </div>

            <div className="space-y-5">
              <Field label="Name">
                <input value={draft.name} onChange={(e) => set("name", e.target.value)} className="inp" />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Max HR (bpm)"><NumInput value={draft.maxHr} min={120} max={230} onChange={(v) => set("maxHr", v)} /></Field>
                <Field label="Rest HR (bpm)"><NumInput value={draft.restHr} min={30} max={90} onChange={(v) => set("restHr", v)} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Age"><NumInput value={draft.age} min={12} max={90} onChange={(v) => set("age", v)} /></Field>
                <Field label="Weight (kg)"><NumInput value={draft.weightKg} min={35} max={180} onChange={(v) => set("weightKg", v)} /></Field>
              </div>

              <Field label="Division">
                <div className="flex bg-white/[0.04] rounded-xl p-0.5 border border-[var(--color-line)]">
                  {(["open", "pro"] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => set("division", d)}
                      className="flex-1 h-9 rounded-lg text-sm font-semibold capitalize transition-colors"
                      style={{ background: draft.division === d ? "var(--color-volt)" : "transparent", color: draft.division === d ? "#0b0c06" : "var(--color-ink-dim)" }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </Field>

              {/* Claude vision (photo import) */}
              <div>
                <div className="card-title mb-2">Photo Import · Claude API Key</div>
                <p className="text-[11px] text-[var(--color-ink-faint)] leading-relaxed mb-2">
                  Only needed for "Analyze photo" in the Workout builder. Get one at platform.claude.com.
                  Stored in this browser only and sent solely to api.anthropic.com — saves as you type.
                </p>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder="Anthropic API key (sk-ant-…)"
                  className="inp"
                  autoComplete="off"
                />
                <select value={model} onChange={(e) => onModelChange(e.target.value)} className="inp mt-2">
                  {VISION_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                {apiKey.trim() && (
                  <div className="mono text-[10px] text-[var(--color-mint)] mt-1.5">✓ key saved on this device</div>
                )}
              </div>

              {/* Strava */}
              <StravaSection strava={strava} />

              {/* Cross-device history sync */}
              <SyncSection sync={sync} />

              {/* zone preview */}
              <div>
                <div className="card-title mb-2">Derived HR Zones</div>
                <div className="space-y-1.5 text-[12px] mono">
                  <ZoneRow z="Z1 Recovery" range={`< ${bounds[0]}`} c="var(--color-z1)" />
                  <ZoneRow z="Z2 Aerobic" range={`${bounds[0]}–${bounds[1]}`} c="var(--color-z2)" />
                  <ZoneRow z="Z3 Tempo" range={`${bounds[1]}–${bounds[2]}`} c="var(--color-z3)" />
                  <ZoneRow z="Z4 Threshold" range={`${bounds[2]}–${bounds[3]}`} c="var(--color-z4)" />
                  <ZoneRow z="Z5 VO2 / Max" range={`${bounds[3]}–${draft.maxHr}`} c="var(--color-z5)" />
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
              className="btn-volt w-full h-11 mt-7 text-sm"
            >
              Save Profile
            </button>
            <p className="text-[11px] text-[var(--color-ink-faint)] mt-3 leading-relaxed">
              Max HR / Rest HR anchor your zones and %HRR interval thresholds. The DFA-α1 thresholds (0.75 = LT1, 0.50 = LT2) are population defaults — pair them with a real lactate/ramp test for your personal anchors.
            </p>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function StravaSection({
  strava: s,
}: {
  strava: {
    config: StravaConfig;
    connected: boolean;
    athlete: string | null;
    onSaveConfig: (c: StravaConfig) => void;
    onConnect: () => void;
    onDisconnect: () => void;
  };
}) {
  const [clientId, setClientId] = useState(s.config.clientId);
  const [workerUrl, setWorkerUrl] = useState(s.config.workerUrl);
  const dirty = clientId !== s.config.clientId || workerUrl !== s.config.workerUrl;
  const configured = clientId.trim() && workerUrl.trim();

  return (
    <div>
      <div className="card-title mb-2">Strava</div>
      {s.connected ? (
        <div className="rounded-lg bg-white/[0.03] border border-[var(--color-line)] p-3">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-2 h-2 rounded-full bg-[#fc4c02]" style={{ boxShadow: "0 0 8px #fc4c02" }} />
            <span className="text-[var(--color-ink)]">Connected{s.athlete ? ` as ${s.athlete}` : ""}</span>
          </div>
          <div className="text-[11px] text-[var(--color-ink-faint)] mt-1">Finished sessions get a "Post to Strava" button (you confirm each upload).</div>
          <button onClick={s.onDisconnect} className="btn-ghost h-8 px-3 mt-2 text-[12px]" style={{ color: "var(--color-red)", borderColor: "rgba(255,77,77,0.3)" }}>Disconnect</button>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-[var(--color-ink-faint)] leading-relaxed mb-2">
            One-time setup needed (Strava app + free Cloudflare Worker) — see strava/README.md in the repo. Paste your Client ID and Worker URL, save, then connect.
          </p>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Strava Client ID" className="inp" autoComplete="off" />
          <input value={workerUrl} onChange={(e) => setWorkerUrl(e.target.value)} placeholder="Worker URL (https://…workers.dev)" className="inp mt-2" autoComplete="off" />
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => s.onSaveConfig({ clientId, workerUrl })}
              disabled={!dirty || !configured}
              className="btn-ghost h-9 px-4 text-[13px] disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={s.onConnect}
              disabled={!configured || dirty}
              title={dirty ? "Save first" : ""}
              className="h-9 px-4 text-[13px] rounded-xl font-semibold disabled:opacity-40"
              style={{ background: "#fc4c02", color: "white" }}
            >
              Connect Strava
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SyncSection({
  sync: s,
}: {
  sync: {
    config: SyncConfig;
    user: string;
    busy: boolean;
    onSaveConfig: (c: SyncConfig) => void;
    onSyncNow: () => void;
  };
}) {
  const [url, setUrl] = useState(s.config.url);
  const [key, setKey] = useState(s.config.key);
  const dirty = url !== s.config.url || key !== s.config.key;
  const configured = !!url.trim() && !!key.trim();
  const live = !!s.config.url && !!s.config.key;

  return (
    <div>
      <div className="card-title mb-2">Cross-device sync</div>
      <p className="text-[11px] text-[var(--color-ink-faint)] leading-relaxed mb-2">
        Off by default — history stays on this device. Add a free Cloudflare Worker (see sync/README.md) so your
        history follows you to any device you sign in on. Same for every crew athlete.
      </p>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Sync URL (https://…workers.dev)" className="inp" autoComplete="off" />
      <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="Sync key" className="inp mt-2" autoComplete="off" />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => s.onSaveConfig({ url, key })}
          disabled={!dirty || !configured}
          className="btn-ghost h-9 px-4 text-[13px] disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={s.onSyncNow}
          disabled={!live || dirty || s.busy}
          title={dirty ? "Save first" : ""}
          className="btn-ghost h-9 px-4 text-[13px] disabled:opacity-40"
        >
          {s.busy ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {live && !dirty && (
        <div className="mono text-[10px] text-[var(--color-mint)] mt-1.5">
          ✓ syncing {s.user ? `${s.user}'s` : "this device's"} history
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] tracking-[0.12em] uppercase text-[var(--color-ink-faint)]">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function NumInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      }}
      className="inp"
    />
  );
}

function ZoneRow({ z, range, c }: { z: string; range: string; c: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: c }} />{z}</span>
      <span className="text-[var(--color-ink-dim)]">{range} bpm</span>
    </div>
  );
}
