/**
 * Athlete identity on native. The web app derives the crew user from the
 * shared-origin `hcUser` (lib/user.ts) — there's no shared origin on a phone, so
 * this is a single stored id (defaults to "david", this app's owner) used to
 * scope saved sessions + history. A future settings screen can switch it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "roxlive.user";
let cached: string | null = null;

export async function getCrewUser(): Promise<string> {
  if (cached) return cached;
  try {
    cached = (await AsyncStorage.getItem(KEY)) || "david";
  } catch {
    cached = "david";
  }
  return cached;
}

export async function setCrewUser(user: string): Promise<void> {
  cached = user;
  try {
    await AsyncStorage.setItem(KEY, user);
  } catch {
    /* ignore */
  }
}
