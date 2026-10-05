import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

/**
 * LAN pairing: one-time token (10 min, first use) → session cookie.
 * Loopback requests are always allowed.
 */
export class LanAuth {
  private token: string | null = null;
  private tokenExpires = 0;
  private sessions = new Set<string>();
  readonly cookieName = "scribui_session";

  issueToken(ttlMs = 10 * 60_000): string {
    this.token = randomBytes(16).toString("hex");
    this.tokenExpires = Date.now() + ttlMs;
    return this.token;
  }

  /** Consume the token; returns a new session id, or null. */
  redeem(token: string | undefined): string | null {
    if (!token || !this.token || token !== this.token || Date.now() > this.tokenExpires) return null;
    this.token = null;
    const s = randomBytes(24).toString("hex");
    this.sessions.add(s);
    return s;
  }

  /** Forget every paired device and any unused pairing link. */
  revokeAll(): void {
    this.sessions.clear();
    this.token = null;
    this.tokenExpires = 0;
  }

  get paired(): number {
    return this.sessions.size;
  }

  get tokenExpiresAt(): number {
    return this.token ? this.tokenExpires : 0;
  }

  valid(session: string | undefined): boolean {
    return !!session && this.sessions.has(session);
  }
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

export function lanAddress(): string | null {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list ?? []) {
      if (n.family !== "IPv4" || n.internal) continue;
      // prefer en0 / wlan / eth
      if (/^(en|eth|wlan|wl)/.test(name)) candidates.unshift(n.address);
      else candidates.push(n.address);
    }
  }
  return candidates[0] ?? null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
