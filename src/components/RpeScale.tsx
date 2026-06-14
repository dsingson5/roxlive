/** CR10 (1-10) Rate of Perceived Exertion selector. */

const RPE_HEX = ["#3dffb5", "#6ee87a", "#b6e83a", "#d8ff3a", "#ffd23a", "#ffb02e", "#ff8a3a", "#ff6b4d", "#ff4d6b", "#ff2d55"];
const RPE_WORD: Record<number, string> = {
  1: "very easy", 2: "easy", 3: "easy", 4: "moderate", 5: "moderate",
  6: "hard", 7: "hard", 8: "very hard", 9: "very hard", 10: "max effort",
};

export function rpeWord(v: number): string {
  return RPE_WORD[v] ?? "";
}
export function rpeColor(v: number): string {
  return RPE_HEX[Math.max(1, Math.min(10, v)) - 1];
}

export function RpeScale({
  value,
  onChange,
  size = "md",
}: {
  value: number | null;
  onChange: (v: number) => void;
  size?: "sm" | "md";
}) {
  const h = size === "sm" ? "h-7" : "h-9";
  const txt = size === "sm" ? "text-[11px]" : "text-[13px]";
  return (
    <div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const sel = value === n;
          return (
            <button
              key={n}
              onClick={() => onChange(n)}
              className={`flex-1 ${h} ${txt} rounded-md font-semibold num transition-all`}
              style={{
                background: sel ? RPE_HEX[n - 1] : "rgba(255,255,255,0.05)",
                color: sel ? "#0b0c06" : "var(--color-ink-dim)",
                border: `1px solid ${sel ? RPE_HEX[n - 1] : "var(--color-line)"}`,
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
      {value != null && (
        <div className="text-[11px] mt-1.5" style={{ color: RPE_HEX[value - 1] }}>
          RPE {value} · {RPE_WORD[value]}
        </div>
      )}
    </div>
  );
}
