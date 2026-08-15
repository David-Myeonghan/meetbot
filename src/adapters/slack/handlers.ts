import type { App } from "@slack/bolt";
import type { CalendarPort } from "../calendar/port.js";
import type { Candidate, MeetingRequest } from "../../domain/types.js";
import { audit } from "../../audit/log.js";
import {
  defaultOptions,
  diagnoseEmpty,
  findCandidates,
  type EngineOptions,
} from "../../engine/availability.js";
import {
  cancelBooking,
  createBooking,
  moveBooking,
  newRequestId,
} from "../../executor/booking.js";
import { candidateCard, doneCard, failCard, meetingForm } from "./blocks.js";

/**
 * 핸들러 — 순서 지휘만 한다. 무상태.
 * 대화 상태(요청·후보 슬롯·이벤트 ID)는 카드 payload가 들고 다닌다.
 */

interface Deps {
  calendar: CalendarPort;
  engineOptions?: EngineOptions;
  /** 슬랙 user ID → 캘린더 이메일 (사내면 프로필 이메일 = 캘린더 계정) */
  emailOf: (userId: string) => Promise<string>;
  /** 연동 URL (google 어댑터일 때) — 없으면 fake 어댑터로 간주 */
  authUrlFor?: (userId: string, email: string) => string;
  /**
   * 확산 훅 (전사 오픈 단계, ENABLE_SPREAD) — 생성의 부수 동작.
   * 미연동·미발송 참석자에게 한 번만 알림. 탐지가 아니라 생성 시점의 대조.
   */
  spread?: (attendeeIds: string[], requesterId: string) => Promise<void>;
}

/** 버튼 payload — 슬롯 + 요청 재현에 필요한 최소 정보 (Block Kit value 2,000자 한도 내) */
interface CreatePayload {
  rid: string;          // requestId (멱등)
  s: number;            // slot start
  e: number;            // slot end
  room?: { id: string; name: string; capacity: number };
  req: {
    u: string;          // requester
    a: string[];        // attendee ids
    d: number;          // duration min
    ws: number;         // window start
    we: number;         // window end
    r: boolean;         // needs room
    t: string;          // title
  };
}

function toRequest(p: CreatePayload): MeetingRequest {
  return {
    requesterId: p.req.u,
    attendeeIds: p.req.a,
    durationMinutes: p.req.d,
    windowStart: p.req.ws,
    windowEnd: p.req.we,
    needsRoom: p.req.r,
    title: p.req.t,
  };
}

const BUSINESS_DAY_MS = 24 * 60 * 60_000;

export function registerHandlers(app: App, deps: Deps): void {
  const opt = deps.engineOptions ?? defaultOptions;

  // ── 진입: /meet → 폼 모달 ──
  app.command("/meet", async ({ ack, body, client }) => {
    await ack();
    audit({ actor: body.user_id, action: "command_invoked" });
    await client.views.open({
      trigger_id: body.trigger_id,
      view: meetingForm(),
    });
  });

  // ── 폼 제출 → 엔진(읽기) → 후보 카드 ──
  app.view("meet_form", async ({ ack, body, view, client }) => {
    const v = view.state.values;
    const title = v["title"]?.["v"]?.value ?? "회의";
    const attendeeIds = v["attendees"]?.["v"]?.selected_users ?? [];
    const duration = Number(v["duration"]?.["v"]?.selected_option?.value ?? 30);
    const windowDays = Number(v["window"]?.["v"]?.selected_option?.value ?? 5);
    const needsRoom =
      (v["room"]?.["v"]?.selected_options ?? []).length > 0;

    const requesterId = body.user.id;
    const allIds = [...new Set([requesterId, ...attendeeIds])];
    if (allIds.length < 2) {
      await ack({
        response_action: "errors",
        errors: { attendees: "본인 외 참석자를 한 명 이상 선택해 주세요." },
      });
      return;
    }
    await ack();

    const now = Date.now();
    const request: MeetingRequest = {
      requesterId,
      attendeeIds: allIds,
      durationMinutes: duration,
      windowStart: now,
      // 영업일 근사: 주말 포함 여유를 두고 달력일로 환산 (엔진이 주말을 걸러냄)
      windowEnd: now + Math.ceil(windowDays * 1.4) * BUSINESS_DAY_MS,
      needsRoom,
      title,
    };

    const emails = await Promise.all(allIds.map(deps.emailOf));
    const requesterEmail = emails[0]!;

    let busy;
    try {
      busy = await deps.calendar.getBusy(
        emails,
        request.windowStart,
        request.windowEnd,
        requesterEmail,
      );
    } catch (e) {
      // 미연동 — 연동 카드 (평문 권한 고지: 무엇을 왜 쓰는지)
      if (
        e instanceof Error &&
        "kind" in e &&
        (e as { kind: string }).kind === "no_permission" &&
        deps.authUrlFor
      ) {
        await client.chat.postMessage({
          channel: requesterId,
          text: "캘린더 연동이 필요해요.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  "*처음이시네요 — 캘린더 연동이 필요해요.*\n봇이 쓰는 권한은 두 가지뿐입니다.\n• 참석자들의 *빈 시간 여부* 조회 (제목·내용은 읽지 않아요)\n• *내 이름으로* 하는 회의 생성·관리",
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  style: "primary",
                  text: { type: "plain_text", text: "연동하기" },
                  action_id: "noop_link",
                  url: deps.authUrlFor(requesterId, requesterEmail),
                },
              ],
            },
          ],
        });
        return;
      }
      throw e;
    }
    const rooms = needsRoom ? await deps.calendar.listRooms(requesterEmail) : [];
    const input = {
      busyByPerson: busy,
      durationMinutes: duration,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      rooms,
      headcount: allIds.length,
      needsRoom,
    };
    const candidates = findCandidates(input, opt);

    if (candidates.length === 0) {
      const reason = diagnoseEmpty(input, opt);
      audit({ actor: requesterId, action: "candidates_empty", reason });
      const msg =
        reason === "no_room"
          ? {
              r: "시간은 있는데 빈 회의실이 없어요.",
              n: "회의실 없이 잡거나, 기간 창을 넓혀 다시 시도해 보세요.",
            }
          : {
              r: `${duration}분짜리 공통 빈 시간이 이 기간엔 없어요.`,
              n: "기간을 넓히거나 인원을 조정해 다시 시도해 보세요.",
            };
      await client.chat.postMessage({
        channel: requesterId,
        text: msg.r,
        blocks: failCard(msg.r, msg.n),
      });
      return;
    }

    const rid = newRequestId();
    audit({ actor: requesterId, action: "candidates_shown", requestId: rid });
    await client.chat.postMessage({
      channel: requesterId,
      text: "회의 시간 후보가 도착했어요.",
      blocks: candidateCard(candidates, (c) =>
        JSON.stringify({
          rid,
          s: c.start,
          e: c.end,
          ...(c.room ? { room: c.room } : {}),
          req: {
            u: requesterId,
            a: allIds,
            d: duration,
            ws: request.windowStart,
            we: request.windowEnd,
            r: needsRoom,
            t: title,
          },
        } satisfies CreatePayload),
      ),
    });
  });

  // ── [이 시간으로 잡기] → 실행기(쓰기) → 완료/실패 카드 ──
  app.action("create_meeting", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (action.type !== "button") return;
    const p = JSON.parse(action.value ?? "{}") as CreatePayload;
    const request = toRequest(p);
    const actorId = body.user.id;

    const emails = await Promise.all(request.attendeeIds.map(deps.emailOf));
    const requesterEmail = await deps.emailOf(request.requesterId);

    const slot: Candidate = {
      start: p.s,
      end: p.e,
      ...(p.room ? { room: p.room } : {}),
    };
    const result = await createBooking(
      { calendar: deps.calendar, engineOptions: opt },
      {
        requestId: p.rid,
        request,
        slot,
        attendeeEmails: emails,
        requesterEmail,
      },
    );

    const channel = actorId;
    if (result.kind === "created") {
      // 후보 카드를 완료 카드로 교체 — 고른 뒤에도 옛 버튼이 남아 눌리는 것을 막는다
      await respond({
        replace_original: true,
        text: "회의를 잡았어요.",
        blocks: doneCard({
          title: request.title,
          start: p.s,
          end: p.e,
          ...(p.room ? { roomName: p.room.name } : {}),
          eventId: result.eventId,
          ...(result.htmlLink !== undefined ? { htmlLink: result.htmlLink } : {}),
          // 시간 변경 = 취소 후 새 후보 — 원 요청을 payload로 재현
          movePayload: JSON.stringify({ eventId: result.eventId, req: p.req }),
        }),
      });
      // 확산 훅 — 실패해도 예약 흐름을 막지 않는다
      if (deps.spread) {
        deps.spread(request.attendeeIds, request.requesterId).catch(() => {});
      }
    } else if (result.kind === "slot_taken") {
      const head = "그 사이 그 시간이 선점됐어요. 새 후보를 다시 찾았습니다.";
      if (result.freshCandidates.length === 0) {
        await respond({
          replace_original: true,
          text: head,
          blocks: failCard(head, "기간을 넓히거나 인원을 조정해 다시 시도해 보세요."),
        });
      } else {
        // 낡은 후보 카드를 새 후보로 교체 — 선점된 슬롯 버튼이 남지 않게
        await respond({
          replace_original: true,
          text: head,
          blocks: [
            ...failCard(head, "아래에서 다시 골라 주세요."),
            ...candidateCard(result.freshCandidates, (c) =>
              JSON.stringify({
                rid: newRequestId(), // 새 시도 = 새 요청 ID
                s: c.start,
                e: c.end,
                ...(c.room ? { room: c.room } : {}),
                req: p.req,
              } satisfies CreatePayload),
            ),
          ],
        });
      }
    } else {
      await client.chat.postMessage({
        channel,
        text: "회의 생성에 실패했어요.",
        blocks: failCard(
          `회의 생성에 실패했어요 (사유: ${result.reason}).`,
          "잠시 후 같은 버튼으로 다시 시도해 주세요. 같은 요청은 중복 생성되지 않습니다.",
        ),
      });
    }
  });

  // ── [취소] — 이벤트 ID는 버튼 value에 (봇이 만든 회의의 카드에만 존재) ──
  app.action("cancel_meeting", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (action.type !== "button") return;
    const eventId = action.value ?? "";
    const actorId = body.user.id;
    const asUser = await deps.emailOf(actorId);
    const result = await cancelBooking(
      { calendar: deps.calendar },
      { actorId, eventId, asUser },
    );
    if (result.ok) {
      await respond({
        replace_original: true,
        text: "회의를 취소했어요. 초대를 회수하고 회의실을 반납했습니다.",
      });
    } else {
      await client.chat.postMessage({
        channel: actorId,
        text: "취소에 실패했어요.",
        blocks: failCard(
          `취소에 실패했어요 (사유: ${result.reason}).`,
          "이미 취소됐거나 캘린더에서 직접 삭제된 회의일 수 있어요. 캘린더에서 확인해 주세요.",
        ),
      });
    }
  });

  // ── [시간 변경] — 새 후보를 다시 제시, 고르면 기존 회의 이동 ──
  app.action("move_meeting", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const { eventId, req } = JSON.parse(action.value ?? "{}") as {
      eventId: string;
      req: CreatePayload["req"];
    };
    const actorId = body.user.id;
    const emails = await Promise.all(req.a.map(deps.emailOf));
    const requesterEmail = await deps.emailOf(req.u);

    const now = Date.now();
    const windowEnd = now + Math.ceil(5 * 1.4) * BUSINESS_DAY_MS;
    const busy = await deps.calendar.getBusy(emails, now, windowEnd, requesterEmail);
    const rooms = req.r ? await deps.calendar.listRooms(requesterEmail) : [];
    const candidates = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: req.d,
        windowStart: now,
        windowEnd,
        rooms,
        headcount: req.a.length,
        needsRoom: req.r,
      },
      opt,
    );

    if (candidates.length === 0) {
      await client.chat.postMessage({
        channel: actorId,
        text: "옮길 수 있는 공통 빈 시간이 없어요.",
        blocks: failCard(
          "옮길 수 있는 공통 빈 시간이 없어요.",
          "기간을 넓혀 다시 시도하거나, 캘린더에서 직접 조정해 주세요.",
        ),
      });
      return;
    }

    await client.chat.postMessage({
      channel: actorId,
      text: "새 시간 후보예요.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*새 시간을 고르면 기존 회의가 그 시간으로 이동합니다.*" },
        },
        ...candidates.map((c) => ({
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `*${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(c.start))}*`,
          },
          accessory: {
            type: "button" as const,
            text: { type: "plain_text" as const, text: "이 시간으로 이동" },
            action_id: "confirm_move",
            value: JSON.stringify({ eventId, s: c.start, e: c.end, u: req.u }),
          },
        })),
      ],
    });
  });

  // URL 버튼 클릭 ack (링크는 브라우저가 처리)
  app.action("noop_link", async ({ ack }) => {
    await ack();
  });

  app.action("confirm_move", async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== "button") return;
    const { eventId, s, e, u } = JSON.parse(action.value ?? "{}") as {
      eventId: string;
      s: number;
      e: number;
      u: string;
    };
    const actorId = body.user.id;
    const asUser = await deps.emailOf(u);
    const result = await moveBooking(
      { calendar: deps.calendar },
      { actorId, eventId, newStart: s, newEnd: e, asUser },
    );
    await respond({
      replace_original: true,
      text: result.ok
        ? "회의를 옮겼어요. 참석자에게 변경 알림이 갑니다."
        : `이동에 실패했어요 (사유: ${result.reason}). 캘린더에서 직접 조정해 주세요.`,
    });
  });
}
