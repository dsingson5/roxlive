/**
 * Friendly names for connected heart-rate sensors, remembered per device id so a
 * crew member's strap is recognizable next time ("David's Polar H10"). Stored
 * per-device on this browser (the BLE device id is stable per browser+device).
 */

const KEY = "roxlive.hrm.names.v1";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

/** The saved custom name for a device id, or null. */
export function getDeviceName(id: string | null | undefined): string | null {
  if (!id) return null;
  const n = load()[id];
  return n && n.trim() ? n : null;
}

/** Save (or clear, when blank) a custom name for a device id. */
export function setDeviceName(id: string, name: string): void {
  if (!id) return;
  try {
    const all = load();
    const t = (name || "").trim();
    if (t) all[id] = t;
    else delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Default name for a freshly-connected sensor: "<User>'s <Brand>". */
export function defaultDeviceName(brand: string | null | undefined, user: string | null | undefined): string {
  const b = (brand || "HR Sensor").trim();
  const u = (user || "").trim();
  return u ? `${u}'s ${b}` : b;
}

/** Resolve what to show for a device: the saved name, else the brand. */
export function resolveDeviceLabel(id: string | null | undefined, brand: string | null | undefined): string {
  return getDeviceName(id) || (brand || "HR Sensor");
}
