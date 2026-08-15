import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 사용자 표 — 봇이 소유하는 유일한 저장소.
 * {슬랙 user ID, 이메일, 암호화된 위임 토큰, 확산 알림 발송 표시, 옵트아웃}
 * 수백 행 규모 — 파일 DB(SQLite)면 충분하고 캐시·큐는 필요 없다.
 */

const DB_PATH = new URL("../../data/users.db", import.meta.url).pathname;

export interface UserRow {
  slackUserId: string;
  email: string;
  hasToken: boolean;
  nudgedAt: string | null;
  optedOut: boolean;
}

export class UserStore {
  private db: Database.Database;
  private key: Buffer;

  constructor(encKeyHex: string, dbPath: string = DB_PATH) {
    if (!/^[0-9a-f]{64}$/i.test(encKeyHex)) {
      throw new Error("TOKEN_ENC_KEY는 32바이트 hex여야 합니다 (`openssl rand -hex 32`)");
    }
    this.key = Buffer.from(encKeyHex, "hex");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        slack_user_id TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        token_enc     TEXT,           -- iv:tag:ciphertext (base64) — 위임 refresh token
        nudged_at     TEXT,           -- 확산 알림 발송 표시 (같은 사람에게 한 번만)
        opted_out     INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString("base64")).join(":");
  }

  private decrypt(stored: string): string {
    const [ivB64, tagB64, encB64] = stored.split(":");
    if (!ivB64 || !tagB64 || !encB64) throw new Error("잘못된 토큰 형식");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return (
      decipher.update(Buffer.from(encB64, "base64"), undefined, "utf8") +
      decipher.final("utf8")
    );
  }

  saveToken(slackUserId: string, email: string, refreshToken: string): void {
    this.db
      .prepare(
        `INSERT INTO users (slack_user_id, email, token_enc) VALUES (?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET email = excluded.email, token_enc = excluded.token_enc`,
      )
      .run(slackUserId, email, this.encrypt(refreshToken));
  }

  getTokenByEmail(email: string): string | undefined {
    const row = this.db
      .prepare(`SELECT token_enc FROM users WHERE email = ?`)
      .get(email) as { token_enc: string | null } | undefined;
    return row?.token_enc ? this.decrypt(row.token_enc) : undefined;
  }

  isLinked(email: string): boolean {
    return this.getTokenByEmail(email) !== undefined;
  }

  /** 확산 알림 — 같은 사람에게 한 번만, 옵트아웃 존중 */
  shouldNudge(slackUserId: string): boolean {
    const row = this.db
      .prepare(`SELECT nudged_at, opted_out, token_enc FROM users WHERE slack_user_id = ?`)
      .get(slackUserId) as
      | { nudged_at: string | null; opted_out: number; token_enc: string | null }
      | undefined;
    if (!row) return true; // 표에 없음 = 미연동·미발송
    return !row.token_enc && !row.nudged_at && row.opted_out === 0;
  }

  markNudged(slackUserId: string, email: string): void {
    this.db
      .prepare(
        `INSERT INTO users (slack_user_id, email, nudged_at) VALUES (?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET nudged_at = excluded.nudged_at`,
      )
      .run(slackUserId, email, new Date().toISOString());
  }

  optOut(slackUserId: string): void {
    this.db
      .prepare(`UPDATE users SET opted_out = 1 WHERE slack_user_id = ?`)
      .run(slackUserId);
  }
}
