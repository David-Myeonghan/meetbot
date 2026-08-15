import { createHash } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import type {
  BusyByPerson,
  BusyInterval,
  CreatedEvent,
  Room,
} from "../../domain/types.js";
import { CalendarError } from "../../domain/types.js";
import type { CalendarPort } from "./port.js";
import type { UserStore } from "../../store/users.js";

/**
 * Google Calendar 어댑터 — 번역만 한다.
 * 호출 자격: 요청자의 개인 위임 토큰 (관리자 위임이 아니라 개인 동의 모델).
 * 멱등: 결정적 이벤트 ID(요청 ID의 해시)로 insert — 같은 ID의 중복 생성을 구글이 409로 거른다.
 */

export class GoogleCalendar implements CalendarPort {
  constructor(
    private store: UserStore,
    private clientId = process.env["GOOGLE_CLIENT_ID"] ?? "",
    private clientSecret = process.env["GOOGLE_CLIENT_SECRET"] ?? "",
    private redirect = process.env["GOOGLE_OAUTH_REDIRECT"] ?? "",
  ) {}

  private clientFor(userEmail: string): calendar_v3.Calendar {
    const refreshToken = this.store.getTokenByEmail(userEmail);
    if (!refreshToken) {
      throw new CalendarError(
        "no_permission",
        `${userEmail} 미연동 — 캘린더 권한 동의가 필요합니다`,
      );
    }
    const auth = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirect,
    );
    auth.setCredentials({ refresh_token: refreshToken });
    return google.calendar({ version: "v3", auth });
  }

  async getBusy(
    emails: string[],
    windowStart: number,
    windowEnd: number,
    asUser: string,
  ): Promise<BusyByPerson> {
    const cal = this.clientFor(asUser);
    try {
      const res = await cal.freebusy.query({
        requestBody: {
          timeMin: new Date(windowStart).toISOString(),
          timeMax: new Date(windowEnd).toISOString(),
          items: emails.map((id) => ({ id })),
        },
      });
      const out: BusyByPerson = new Map();
      for (const email of emails) {
        const busy = res.data.calendars?.[email]?.busy ?? [];
        // 벤더 응답 → 중립 모델 정규화 (Google freebusy는 바쁜 구간만 준다 — tentative 라벨 없음)
        const intervals: BusyInterval[] = busy
          .filter((b) => b.start && b.end)
          .map((b) => ({
            start: Date.parse(b.start!),
            end: Date.parse(b.end!),
          }));
        out.set(email, intervals);
      }
      return out;
    } catch (e) {
      throw this.translate(e);
    }
  }

  /**
   * 회의실: Google Workspace 리소스 캘린더는 조직 기능.
   * 개인 환경에선 GOOGLE_ROOMS 환경변수(JSON: [{email,name,capacity}])로 방 캘린더를 지정.
   */
  async listRooms(): Promise<Room[]> {
    const raw = process.env["GOOGLE_ROOMS"];
    if (!raw) return [];
    try {
      const rooms = JSON.parse(raw) as { email: string; name: string; capacity: number }[];
      return rooms.map((r) => ({ id: r.email, name: r.name, capacity: r.capacity }));
    } catch {
      return [];
    }
  }

  async createEvent(params: {
    requestId: string;
    title: string;
    start: number;
    end: number;
    attendeeEmails: string[];
    roomEmail?: string;
    asUser: string;
  }): Promise<CreatedEvent> {
    const cal = this.clientFor(params.asUser);
    // 결정적 이벤트 ID — 요청 ID가 같으면 같은 ID → 구글이 중복 생성을 거른다 (멱등 위임)
    // (허용 문자 [a-v0-9] — sha256 hex는 [0-9a-f]라 부분집합)
    const eventId = createHash("sha256")
      .update(params.requestId)
      .digest("hex")
      .slice(0, 40);
    const attendees: calendar_v3.Schema$EventAttendee[] =
      params.attendeeEmails.map((email) => ({ email }));
    if (params.roomEmail) {
      attendees.push({ email: params.roomEmail, resource: true }); // 회의실 = 리소스 참석자
    }
    try {
      const res = await cal.events.insert({
        calendarId: "primary",
        sendUpdates: "all",
        requestBody: {
          id: eventId,
          summary: params.title,
          start: { dateTime: new Date(params.start).toISOString() },
          end: { dateTime: new Date(params.end).toISOString() },
          attendees,
        },
      });
      return {
        eventId,
        ...(res.data.htmlLink ? { htmlLink: res.data.htmlLink } : {}),
      };
    } catch (e) {
      const status = (e as { code?: number }).code;
      if (status === 409) {
        // 같은 요청 ID의 재시도 — 이미 생성됨 (멱등 성공)
        return { eventId };
      }
      throw this.translate(e);
    }
  }

  async cancelEvent(eventId: string, asUser: string): Promise<void> {
    const cal = this.clientFor(asUser);
    try {
      await cal.events.delete({
        calendarId: "primary",
        eventId,
        sendUpdates: "all",
      });
    } catch (e) {
      throw this.translate(e);
    }
  }

  async moveEvent(
    eventId: string,
    newStart: number,
    newEnd: number,
    asUser: string,
  ): Promise<void> {
    const cal = this.clientFor(asUser);
    try {
      await cal.events.patch({
        calendarId: "primary",
        eventId,
        sendUpdates: "all",
        requestBody: {
          start: { dateTime: new Date(newStart).toISOString() },
          end: { dateTime: new Date(newEnd).toISOString() },
        },
      });
    } catch (e) {
      throw this.translate(e);
    }
  }

  /** 벤더 에러 → 중립 에러 타입 번역 */
  private translate(e: unknown): CalendarError {
    if (e instanceof CalendarError) return e;
    const status = (e as { code?: number }).code;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 401 || status === 403) return new CalendarError("no_permission", msg);
    if (status === 404) return new CalendarError("not_found", msg);
    if (status === 429) return new CalendarError("rate_limited", msg);
    return new CalendarError("unknown", msg);
  }
}
