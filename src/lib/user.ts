/**
 * Crew identity. RoxLive is served from the same origin as the Hybrid Crew hub
 * (https://dsingson5.github.io/{hybrid-crew,roxlive}/), so it can read who is
 * signed in to the crew (`hcUser`) and scope each athlete's saved workout
 * history to them. Resolution order (first hit wins):
 *   1. hcUser            — set by the hub's entrance gate (local/sessionStorage).
 *                          AUTHORITATIVE: it reflects who is actually signed in on
 *                          this origin, so it outranks the URL param. That keeps
 *                          one signed-in athlete from scoping RoxLive to another's
 *                          history with a crafted ?user= link, and keeps the hub's
 *                          card count (which keys off hcUser) in agreement.
 *   2. ?user= URL param  — only when there is NO crew sign-in on this origin
 *                          (e.g. a link straight to RoxLive). Honored for the
 *                          visit but NOT persisted, so a one-off shared link can't
 *                          durably rebind the athlete on later bare-URL visits.
 *   3. roxlive.user      — the last hcUser-derived identity (sticks across reloads)
 * Falls back to null (anonymous → the shared, unscoped history) when none match.
 *
 * The candidate is always validated against the crew allow-list before use, so
 * a hand-crafted ?user= value can never become a storage key or a display name.
 */

/** Allow-list — mirrors hybrid-crew/enter.html. All ids are lower-case. */
export const CREW_USERS = [
  "david",
  "carla",
  "erika",
  "liz",
  "marianne",
  "aleena",
  "fayth",
  "aura",
  "levelshyroxpt-sample",
  "ommohyroxpc-sample",
] as const;

export type CrewUser = (typeof CREW_USERS)[number];

const USER_KEY = "roxlive.user";

function isCrewUser(u: string | null | undefined): u is CrewUser {
  return !!u && (CREW_USERS as readonly string[]).includes(u);
}

function fromUrl(): string | null {
  try {
    const p = new URLSearchParams(window.location.search).get("user");
    return p ? p.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function fromStore(key: string): string | null {
  try {
    return (localStorage.getItem(key) || sessionStorage.getItem(key) || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function persist(u: string): void {
  try {
    localStorage.setItem(USER_KEY, u);
  } catch {
    /* ignore */
  }
}

/**
 * The current crew user, or null when anonymous. Reads cheap sources every call
 * so history keys stay correct regardless of when it runs; persists the latest
 * crew identity so it survives a reload that drops the ?user= param.
 */
export function resolveCrewUser(): CrewUser | null {
  // 1. hcUser is authoritative — the gate-set, signed-in identity wins over the
  //    URL param so it cannot be overridden by a crafted ?user= link.
  const hc = fromStore("hcUser");
  if (isCrewUser(hc)) {
    persist(hc);
    return hc;
  }
  // 2. No crew sign-in here — honor a validated ?user= for this visit only.
  //    Deliberately NOT persisted: a one-off link must not durably rebind history.
  const url = fromUrl();
  if (isCrewUser(url)) return url;

  // 3. Fall back to the last hcUser-derived identity we persisted.
  const saved = fromStore(USER_KEY);
  if (isCrewUser(saved)) return saved;
  return null;
}

/** "david" → "David". (Sample ids stay as-is past the first letter.) */
export function prettyUser(u: string | null | undefined): string {
  if (!u) return "";
  return u.charAt(0).toUpperCase() + u.slice(1);
}

/**
 * Each athlete's training-calendar page on the Hybrid Crew hub (filenames are
 * relative to ../hybrid-crew/). Used for the "My Calendar" shortcut and to fetch
 * a user's programmed workouts into RoxLive. Keep in sync with CREW_USERS — a
 * user missing here just doesn't get the shortcut (handled gracefully).
 */
export const CALENDAR_PAGES: Partial<Record<CrewUser, string>> = {
  david: "david-year-calendar.html",
  carla: "jakarta-taper-competitive.html",
  erika: "jakarta-taper-competitive.html",
  liz: "jakarta-taper-firsttimers.html",
  marianne: "jakarta-taper-firsttimers.html",
  aleena: "jakarta-taper-mixed.html",
  aura: "aura-training-calendar.html",
  fayth: "fayths-training-plan.html",
  "levelshyroxpt-sample": "levels-hyrox-2027-calendar.html",
  "ommohyroxpc-sample": "ommo-hyrox-2027-calendar.html",
};

/** The calendar page file for a user, or null if they have none. */
export function calendarPageFor(u: string | null | undefined): string | null {
  if (!u) return null;
  return (CALENDAR_PAGES as Record<string, string>)[u] || null;
}
