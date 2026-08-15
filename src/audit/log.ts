import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 감사 로그 — DB가 아니라 JSON 한 줄 로그.
 * 봇 서버의 로그 파일에 남고(환경에 로그 서비스가 있으면 자동 수집),
 * 게이트 지표는 전부 이 로그를 세서 얻는다.
 */

export type AuditAction =
  | "command_invoked"   // 호출 수
  | "candidates_shown"  // 후보 제시 (채택률 분모)
  | "candidates_empty"  // 실패 사유 분포
  | "create_attempted"
  | "create_succeeded"  // 생성 성공률 분자 / 채택률 분자
  | "create_failed"
  | "revalidation_conflict" // 재검증이 잡은 선점
  | "room_declined"       // 방의 사후 자동 거절 — 오예약 0건 게이트의 측정 대상
  | "cancel"
  | "move"
  | "spread_nudge_sent";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: AuditAction;
  requestId?: string;
  eventId?: string;
  outcome?: "ok" | "fail";
  reason?: string;
}

const LOG_PATH = new URL("../../data/audit.log", import.meta.url).pathname;
let dirReady = false;

export function audit(entry: Omit<AuditEntry, "ts">): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line); // stdout — 환경 로그 수집이 여기서 줍는다
  try {
    if (!dirReady) {
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      dirReady = true;
    }
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // 파일 기록 실패는 봇 동작을 막지 않는다 — stdout이 1차 채널
  }
}
