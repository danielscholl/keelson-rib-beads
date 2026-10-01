import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.ts";

export type Role = "viewer" | "billing" | "admin";

export interface Session {
  token: string;
  userId: string;
  role: Role;
  expiresAt: number;
}

const RANK: Record<Role, number> = { viewer: 0, billing: 1, admin: 2 };

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Sessions {
  private readonly byToken = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(userId: string, role: Role): Session {
    const session: Session = {
      token: crypto.randomUUID(),
      userId,
      role,
      expiresAt: this.now() + this.ttlMs,
    };
    this.byToken.set(session.token, session);
    return session;
  }

  verify(token: string | undefined): Session {
    if (!token) throw new HttpError(401, "missing token");
    const session = this.byToken.get(token);
    if (!session || !sameToken(session.token, token)) throw new HttpError(401, "unknown token");
    if (session.expiresAt <= this.now()) {
      this.byToken.delete(token);
      throw new HttpError(401, "session expired");
    }
    return session;
  }

  revoke(token: string): void {
    this.byToken.delete(token);
  }
}

export function requireRole(session: Session, role: Role): void {
  if (RANK[session.role] < RANK[role]) throw new HttpError(403, `requires ${role}`);
}
