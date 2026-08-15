import { randomUUID } from "node:crypto";
import type { CalendarPort } from "../adapters/calendar/port.js";
import type { Candidate, MeetingRequest } from "../domain/types.js";
import { CalendarError } from "../domain/types.js";
import { audit } from "../audit/log.js";
import { findCandidates, defaultOptions, type EngineOptions } from "../engine/availability.js";

/**
 * 예약 실행기 — 캘린더에 손을 대는 유일한 쓰기 경로.
 * 안전장치는 쓰기 경로가 태어날 때 한 몸으로:
 *   확인 후 쓰기(호출 자체가 버튼 클릭 뒤) · 생성 직전 재검증 · 요청 ID 멱등(캘린더 위임) · 감사 로그.
 */

export interface BookingDeps {
  calendar: CalendarPort;
  engineOptions?: EngineOptions;
}

export type BookingResult =
  | { kind: "created"; eventId: string; htmlLink?: string }
  | { kind: "slot_taken"; freshCandidates: Candidate[] }
  | { kind: "failed"; reason: string };

export async function createBooking(
  deps: BookingDeps,
  params: {
    requestId: string;
    request: MeetingRequest;
    slot: Candidate;
    attendeeEmails: string[];
    requesterEmail: string;
  },
): Promise<BookingResult> {
  const { calendar } = deps;
  const opt = deps.engineOptions ?? defaultOptions;
  const { requestId, request, slot, attendeeEmails, requesterEmail } = params;

  audit({
    actor: request.requesterId,
    action: "create_attempted",
    requestId,
  });

  // 생성 직전 재검증 — 후보 제시와 클릭 사이에 슬롯이 선점됐을 수 있다
  const busy = await calendar.getBusy(
    attendeeEmails,
    slot.start,
    slot.end,
    requesterEmail,
  );
  const stillFree = [...busy.values()].every((intervals) =>
    intervals.every((iv) => iv.end <= slot.start || iv.start >= slot.end),
  );

  if (!stillFree) {
    audit({
      actor: request.requesterId,
      action: "revalidation_conflict",
      requestId,
    });
    // 충돌이면 만들지 않고 새 후보를 다시 제시
    const freshBusy = await calendar.getBusy(
      attendeeEmails,
      request.windowStart,
      request.windowEnd,
      requesterEmail,
    );
    const rooms = request.needsRoom ? await calendar.listRooms(requesterEmail) : [];
    const freshCandidates = findCandidates(
      {
        busyByPerson: freshBusy,
        durationMinutes: request.durationMinutes,
        windowStart: request.windowStart,
        windowEnd: request.windowEnd,
        rooms,
        headcount: attendeeEmails.length,
        needsRoom: request.needsRoom,
      },
      opt,
    );
    return { kind: "slot_taken", freshCandidates };
  }

  try {
    const created = await calendar.createEvent({
      requestId, // 멱등은 캘린더에 위임 — 같은 ID의 중복 생성을 캘린더가 거른다
      title: request.title,
      start: slot.start,
      end: slot.end,
      attendeeEmails,
      ...(slot.room ? { roomEmail: slot.room.id } : {}),
      asUser: requesterEmail,
    });
    audit({
      actor: request.requesterId,
      action: "create_succeeded",
      requestId,
      eventId: created.eventId,
      outcome: "ok",
    });
    return {
      kind: "created",
      eventId: created.eventId,
      ...(created.htmlLink !== undefined ? { htmlLink: created.htmlLink } : {}),
    };
  } catch (e) {
    const reason =
      e instanceof CalendarError ? e.kind : "unknown";
    audit({
      actor: request.requesterId,
      action: "create_failed",
      requestId,
      outcome: "fail",
      reason,
    });
    return { kind: "failed", reason };
  }
}

export async function cancelBooking(
  deps: BookingDeps,
  params: { actorId: string; eventId: string; asUser: string },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await deps.calendar.cancelEvent(params.eventId, params.asUser);
    audit({ actor: params.actorId, action: "cancel", eventId: params.eventId, outcome: "ok" });
    return { ok: true };
  } catch (e) {
    const reason = e instanceof CalendarError ? e.kind : "unknown";
    audit({ actor: params.actorId, action: "cancel", eventId: params.eventId, outcome: "fail", reason });
    return { ok: false, reason };
  }
}

export async function moveBooking(
  deps: BookingDeps,
  params: {
    actorId: string;
    eventId: string;
    newStart: number;
    newEnd: number;
    asUser: string;
  },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await deps.calendar.moveEvent(
      params.eventId,
      params.newStart,
      params.newEnd,
      params.asUser,
    );
    audit({ actor: params.actorId, action: "move", eventId: params.eventId, outcome: "ok" });
    return { ok: true };
  } catch (e) {
    const reason = e instanceof CalendarError ? e.kind : "unknown";
    audit({ actor: params.actorId, action: "move", eventId: params.eventId, outcome: "fail", reason });
    return { ok: false, reason };
  }
}

export function newRequestId(): string {
  return randomUUID();
}
