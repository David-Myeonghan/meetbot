import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BusyByPerson,
  BusyInterval,
  CreatedEvent,
  Room,
} from "../../domain/types.js";
import { CalendarError } from "../../domain/types.js";
import type { CalendarPort } from "./port.js";

/**
 * 가짜 캘린더 어댑터 — 실제 캘린더 없이 전체 사이클을 테스트하기 위한 것.
 * 벤더의 멱등(요청 ID 중복 차단)까지 흉내 낸다.
 * 실제 벤더처럼 상태가 봇 프로세스 밖에 살아남아야 하므로(멱등 장부는 재시작과 무관해야 함)
 * persistPath를 주면 디스크에 영속한다.
 */
export class FakeCalendar implements CalendarPort {
  private busy = new Map<string, BusyInterval[]>();
  private events = new Map<
    string,
    { title: string; start: number; end: number; attendees: string[]; roomEmail?: string }
  >();
  private byRequestId = new Map<string, string>(); // requestId → eventId (멱등)
  private persistPath: string | undefined;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath && existsSync(persistPath)) {
      const raw = JSON.parse(readFileSync(persistPath, "utf8")) as {
        events: [string, { title: string; start: number; end: number; attendees: string[]; roomEmail?: string }][];
        byRequestId: [string, string][];
      };
      this.events = new Map(raw.events);
      this.byRequestId = new Map(raw.byRequestId);
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    writeFileSync(
      this.persistPath,
      JSON.stringify({
        events: [...this.events.entries()],
        byRequestId: [...this.byRequestId.entries()],
      }),
    );
  }
  private rooms: Room[] = [
    { id: "room-2a", name: "2인실 A", capacity: 2 },
    { id: "room-4a", name: "4인실 A", capacity: 4 },
    { id: "room-8a", name: "8인실 A", capacity: 8 },
  ];

  /** 테스트/데모용: 바쁜 구간 심기 */
  seedBusy(email: string, intervals: BusyInterval[]): void {
    this.busy.set(email, intervals);
  }

  async getBusy(
    emails: string[],
    windowStart: number,
    windowEnd: number,
  ): Promise<BusyByPerson> {
    const out: BusyByPerson = new Map();
    for (const email of emails) {
      const all = this.busy.get(email) ?? [];
      // 생성된 이벤트도 바쁜 구간에 반영 (재검증이 실제로 동작하게).
      // 방(roomEmail)도 캘린더이므로 같은 경로로 바쁨이 조회된다
      const fromEvents = [...this.events.values()]
        .filter((e) => e.attendees.includes(email) || e.roomEmail === email)
        .map((e) => ({ start: e.start, end: e.end }));
      out.set(
        email,
        [...all, ...fromEvents].filter(
          (iv) => iv.start < windowEnd && iv.end > windowStart,
        ),
      );
    }
    return out;
  }

  async listRooms(): Promise<Room[]> {
    return this.rooms;
  }

  async createEvent(params: {
    requestId: string;
    title: string;
    start: number;
    end: number;
    attendeeEmails: string[];
    roomEmail?: string;
  }): Promise<CreatedEvent> {
    // 멱등: 같은 requestId면 기존 이벤트를 그대로 돌려준다 (벤더 동작 모사)
    const existing = this.byRequestId.get(params.requestId);
    if (existing) return { eventId: existing };

    const eventId = `fake-${randomUUID()}`;
    this.events.set(eventId, {
      title: params.title,
      start: params.start,
      end: params.end,
      attendees: params.attendeeEmails,
      ...(params.roomEmail !== undefined ? { roomEmail: params.roomEmail } : {}),
    });
    this.byRequestId.set(params.requestId, eventId);
    this.persist();
    return { eventId };
  }

  async cancelEvent(eventId: string): Promise<void> {
    if (!this.events.has(eventId)) {
      throw new CalendarError("not_found", `event ${eventId} not found`);
    }
    this.events.delete(eventId);
    this.persist();
  }

  async moveEvent(
    eventId: string,
    newStart: number,
    newEnd: number,
  ): Promise<void> {
    const ev = this.events.get(eventId);
    if (!ev) throw new CalendarError("not_found", `event ${eventId} not found`);
    ev.start = newStart;
    ev.end = newEnd;
    this.persist();
  }
}
