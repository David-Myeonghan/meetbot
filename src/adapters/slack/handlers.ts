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
import { candidateCard, doneCard, failCard, fmtSlot, meetingForm } from "./blocks.js";

/** 버튼이 눌린 원본 메시지 좌표 — 카드 제자리 갱신(chat.update)과 스레드 히스토리의 앵커 */
function anchorOf(body: unknown): { channel: string; ts: string } {
  const b = body as {
    container?: { channel_id?: string; message_ts?: string };
    channel?: { id?: string };
  };
  return {
    channel: b.container?.channel_id ?? b.channel?.id ?? "",
    ts: b.container?.message_ts ?? "",
  };
}

/**
 * 핸들러 — 순서 지휘만 한다. 무상태.
 * 대화 상태(요청·후보 슬롯·이벤트 ID)는 카드 payload가 들고 다닌다.
 */

interface Deps {
  calendar: CalendarPort;
  engineOptions?: EngineOptions;
  /** 슬랙 user ID → 캘린더 이메일 (사내면 프로필 이메일 = 캘린더 계정) */
  emailOf: (userId: string) => Promise<string>;
  /** 연동 URL (google 어댑터일 때) — 없으면 fake 어댑터로 간주. 카드 좌표를 주면 완료 시 카드가 갱신됨 */
  authUrlFor?: (userId: string, email: string, cardChannel?: string, cardTs?: string) => string;
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

  /** 참석자 DM — 연동 여부와 무관한 슬랙 알림. 실패해도 예약 흐름을 막지 않는다 */
  const notifyAttendees = (
    client: { chat: { postMessage: (a: { channel: string; text: string }) => Promise<unknown> } },
    attendeeIds: string[],
    exceptId: string,
    text: string,
  ): void => {
    for (const id of new Set(attendeeIds)) {
      if (id === exceptId) continue;
      client.chat.postMessage({ channel: id, text }).catch(() => {});
    }
  };

  // ── 진입: /meet → 폼 모달 ──
  app.command("/meet", async ({ ack, body, client }) => {
    await ack();
    audit({ actor: body.user_id, action: "command_invoked" });
    await client.views.open({
      trigger_id: body.trigger_id,
      view: meetingForm(),
    });
  });

  // ── 소요 시간 드롭다운 변경 → "직접 입력…" 선택 시 입력 칸을 붙인 모달로 갱신 ──
  app.action("duration_select", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "static_select") return;
    const val = action.selected_option?.value ?? "30";
    const view = (body as { view?: { id: string; hash: string; blocks?: { block_id?: string }[] } }).view;
    if (!view) return;
    const hasCustom = view.blocks?.some((b) => b.block_id === "duration_custom") ?? false;
    // 커스텀 칸의 유무가 바뀔 때만 갱신 (다른 입력값은 block_id가 같아 보존됨)
    if ((val === "custom") !== hasCustom) {
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: meetingForm(val),
      });
    }
  });

  // ── 폼 제출 → 엔진(읽기) → 후보 카드 ──
  app.view("meet_form", async ({ ack, body, view, client }) => {
    const v = view.state.values;
    const title = v["title"]?.["v"]?.value ?? "회의";
    const attendeeIds = v["attendees"]?.["v"]?.selected_users ?? [];
    const durationSel =
      v["duration"]?.["duration_select"]?.selected_option?.value ?? "30";
    let duration: number;
    if (durationSel === "custom") {
      const custom = v["duration_custom"]?.["v"]?.value;
      if (!custom) {
        await ack({
          response_action: "errors",
          errors: { duration_custom: "분 단위 숫자를 입력해 주세요 (예: 150)." },
        });
        return;
      }
      duration = Number(custom);
    } else {
      duration = Number(durationSel);
    }
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
        const noticeBlock = {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text:
              "*처음이시네요 — 캘린더 연동이 필요해요.*\n봇이 쓰는 권한은 두 가지뿐입니다.\n• 참석자들의 *빈 시간 여부* 조회 (제목·내용은 읽지 않아요)\n• *내 이름으로* 하는 회의 생성·관리",
          },
        };
        // 카드를 먼저 띄워 좌표(channel, ts)를 얻고, 그 좌표를 OAuth state에 실은
        // 버튼으로 갱신 — 동의가 끝나면 콜백이 이 카드를 "연동 완료"로 바꾼다
        const posted = await client.chat.postMessage({
          channel: requesterId,
          text: "캘린더 연동이 필요해요.",
          blocks: [noticeBlock],
        });
        if (posted.channel && posted.ts) {
          await client.chat.update({
            channel: posted.channel,
            ts: posted.ts,
            text: "캘린더 연동이 필요해요.",
            blocks: [
              noticeBlock,
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    style: "primary",
                    text: { type: "plain_text", text: "연동하기" },
                    action_id: "noop_link",
                    url: deps.authUrlFor(requesterId, requesterEmail, posted.channel, posted.ts),
                  },
                ],
              },
            ],
          });
        }
        return;
      }
      throw e;
    }
    const rooms = needsRoom ? await deps.calendar.listRooms(requesterEmail) : [];
    // 방도 캘린더 — 사람과 같은 free/busy 경로로 바쁨을 조회해 중복 예약을 막는다
    const roomBusy =
      rooms.length > 0
        ? await deps.calendar.getBusy(
            rooms.map((r) => r.id),
            request.windowStart,
            request.windowEnd,
            requesterEmail,
          )
        : new Map();
    const input = {
      busyByPerson: busy,
      durationMinutes: duration,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      rooms,
      roomBusy,
      headcount: allIds.length,
      needsRoom,
    };
    const candidates = findCandidates(input, opt);

    if (candidates.length === 0) {
      const reason = diagnoseEmpty(input, opt);
      audit({ actor: requesterId, action: "candidates_empty", reason });
      const msg =
        reason === "no_room" && rooms.length === 0
          ? {
              r: "이 환경에 등록된 회의실이 없어요.",
              n: "회의실 체크를 끄고 다시 잡아 보세요.",
            }
          : reason === "no_room"
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

    audit({ actor: requesterId, action: "candidates_shown" });
    await client.chat.postMessage({
      channel: requesterId,
      text: "회의 시간 후보가 도착했어요.",
      // 요청 ID는 버튼(슬롯)별로 — 멱등의 단위는 "이 슬롯의 생성"이다.
      // 카드 전체가 공유하면 A 생성 후 B 클릭이 A의 이벤트를 돌려받는 오답이 된다.
      blocks: candidateCard(candidates, (c) =>
        JSON.stringify({
          rid: newRequestId(),
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

    // 카드는 항상 현재 상태로 제자리 변신, 히스토리는 스레드 댓글로 쌓인다
    const anchor = anchorOf(body);
    const historyReply = (text: string) =>
      client.chat.postMessage({ channel: anchor.channel, thread_ts: anchor.ts, text });

    if (result.kind === "created") {
      await client.chat.update({
        channel: anchor.channel,
        ts: anchor.ts,
        text: "회의를 잡았어요.",
        blocks: doneCard({
          title: request.title,
          start: p.s,
          end: p.e,
          ...(p.room ? { roomName: p.room.name } : {}),
          eventId: result.eventId,
          ...(result.htmlLink !== undefined ? { htmlLink: result.htmlLink } : {}),
          movePayload: JSON.stringify({
            eventId: result.eventId,
            s: p.s,
            e: p.e,
            ...(p.room ? { rn: p.room.name } : {}),
            req: p.req,
          }),
        }),
      });
      await historyReply(
        `:white_check_mark: <@${actorId}> 님이 잡음 — ${fmtSlot(p.s, p.e)}${p.room ? ` · ${p.room.name}` : ""}`,
      );
      notifyAttendees(
        client,
        request.attendeeIds,
        actorId,
        `:calendar: <@${actorId}> 님이 회의를 잡았어요 — *${request.title}*\n${fmtSlot(p.s, p.e)}${p.room ? ` · ${p.room.name}` : ""} (캘린더 초대가 발송됐어요)`,
      );
      // 생성 직후 방 수락 확인 — 리소스 캘린더는 충돌 시 사후에 자동 거절하므로
      // 재검증이 못 닫는 마지막 겹침을 여기서 잡는다 ("오예약 0건"을 봇이 스스로 측정)
      if (p.room) {
        const room = p.room;
        setTimeout(async () => {
          try {
            const status = await deps.calendar.roomResponse(
              result.eventId,
              room.id,
              requesterEmail,
            );
            if (status === "declined") {
              audit({
                actor: request.requesterId,
                action: "room_declined",
                eventId: result.eventId,
              });
              await client.chat.postMessage({
                channel: anchor.channel,
                thread_ts: anchor.ts,
                text: `:rotating_light: ${room.name}이(가) 예약을 거절했어요(그 사이 선점). 회의는 잡혔지만 방이 없습니다. [시간 변경]으로 재조율하거나 캘린더에서 방을 바꿔 주세요.`,
              });
            }
          } catch {
            /* 확인 실패는 예약 흐름을 막지 않는다 */
          }
        }, 5000);
      }
      // 확산 훅 — 실패해도 예약 흐름을 막지 않는다
      if (deps.spread) {
        deps.spread(request.attendeeIds, request.requesterId).catch(() => {});
      }
    } else if (result.kind === "slot_taken") {
      const head = "그 사이 그 시간이 선점됐어요. 새 후보를 다시 찾았습니다.";
      if (result.freshCandidates.length === 0) {
        await client.chat.update({
          channel: anchor.channel,
          ts: anchor.ts,
          text: head,
          blocks: failCard(head, "기간을 넓히거나 인원을 조정해 다시 시도해 보세요."),
        });
      } else {
        await client.chat.update({
          channel: anchor.channel,
          ts: anchor.ts,
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
      await historyReply(`:warning: ${fmtSlot(p.s, p.e)} 선점 감지 — 재검증이 생성을 막고 새 후보 제시`);
    } else {
      // 생성 실패 — 카드는 그대로 두고(같은 버튼 재시도 가능) 히스토리에만 남긴다
      await historyReply(
        `:x: 생성 실패 (사유: ${result.reason}) — 같은 버튼으로 재시도해도 중복 생성되지 않아요.`,
      );
    }
  });

  // ── [취소] — 카드는 취소 상태로 변신, 히스토리는 스레드에, 참석자에게 DM ──
  app.action("cancel_meeting", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    // payload = MovePayload JSON (참석자 알림에 제목·참석자 필요). 구버전 카드는 생 eventId
    let eventId = action.value ?? "";
    let cancelInfo: { title: string; s: number; e: number; attendees: string[] } | undefined;
    try {
      const p = JSON.parse(action.value ?? "") as {
        eventId: string;
        s: number;
        e: number;
        req: CreatePayload["req"];
      };
      eventId = p.eventId;
      cancelInfo = { title: p.req.t, s: p.s, e: p.e, attendees: p.req.a };
    } catch {
      /* 구버전 카드 — 알림 없이 취소만 */
    }
    const actorId = body.user.id;
    const anchor = anchorOf(body);
    const asUser = await deps.emailOf(actorId);
    const result = await cancelBooking(
      { calendar: deps.calendar },
      { actorId, eventId, asUser },
    );
    if (result.ok && cancelInfo) {
      notifyAttendees(
        client,
        cancelInfo.attendees,
        actorId,
        `:no_entry_sign: <@${actorId}> 님이 회의를 취소했어요 — *${cancelInfo.title}*\n${fmtSlot(cancelInfo.s, cancelInfo.e)}`,
      );
    }
    if (result.ok) {
      await client.chat.update({
        channel: anchor.channel,
        ts: anchor.ts,
        text: "회의를 취소했어요.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":no_entry_sign: *취소됨* — 초대를 회수하고 회의실을 반납했습니다.",
            },
          },
        ],
      });
      await client.chat.postMessage({
        channel: anchor.channel,
        thread_ts: anchor.ts,
        text: `:no_entry_sign: <@${actorId}> 님이 취소함`,
      });
    } else {
      await client.chat.postMessage({
        channel: anchor.channel,
        thread_ts: anchor.ts,
        text: `:x: 취소 실패 (사유: ${result.reason}) — 이미 취소됐거나 캘린더에서 직접 삭제된 회의일 수 있어요.`,
      });
    }
  });

  /** 이동 payload — 완료 카드가 들고 다니는 현재 상태 */
  interface MovePayload {
    eventId: string;
    s: number;
    e: number;
    rn?: string;
    req: CreatePayload["req"];
  }

  // ── [시간 변경] — 같은 카드가 새 후보 카드로 변신, 고르면 다시 완료 카드로 ──
  app.action("move_meeting", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const p = JSON.parse(action.value ?? "{}") as MovePayload;
    const anchor = anchorOf(body);
    const emails = await Promise.all(p.req.a.map(deps.emailOf));
    const requesterEmail = await deps.emailOf(p.req.u);

    const now = Date.now();
    const windowEnd = now + Math.ceil(5 * 1.4) * BUSINESS_DAY_MS;
    const busy = await deps.calendar.getBusy(emails, now, windowEnd, requesterEmail);
    // 이동은 사람 가용성만 본다 — 회의실은 그대로 따라간다 (v1 단순화)
    const candidates = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: p.req.d,
        windowStart: now,
        windowEnd,
        headcount: p.req.a.length,
        needsRoom: false,
      },
      opt,
    );

    if (candidates.length === 0) {
      await client.chat.postMessage({
        channel: anchor.channel,
        thread_ts: anchor.ts,
        text: ":warning: 옮길 수 있는 공통 빈 시간이 없어요 — 기간을 넓혀 다시 시도하거나 캘린더에서 직접 조정해 주세요.",
      });
      return;
    }

    await client.chat.update({
      channel: anchor.channel,
      ts: anchor.ts,
      text: "새 시간을 고르면 이동합니다.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*새 시간을 고르면 이동합니다.* (현재: ${fmtSlot(p.s, p.e)}${p.rn ? ` · ${p.rn}` : ""} — 회의실은 그대로 유지)`,
          },
        },
        ...candidates.map((c) => ({
          type: "section" as const,
          text: { type: "mrkdwn" as const, text: `*${fmtSlot(c.start, c.end)}*` },
          accessory: {
            type: "button" as const,
            text: { type: "plain_text" as const, text: "이 시간으로 이동" },
            action_id: "confirm_move",
            value: JSON.stringify({ ...p, ns: c.start, ne: c.end }),
          },
        })),
        {
          type: "actions" as const,
          elements: [
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: "그대로 두기" },
              action_id: "abort_move",
              value: JSON.stringify(p),
            },
          ],
        },
      ],
    });
  });

  const renderDone = (p: MovePayload, headline?: string) =>
    doneCard({
      title: p.req.t,
      start: p.s,
      end: p.e,
      ...(p.rn ? { roomName: p.rn } : {}),
      eventId: p.eventId,
      movePayload: JSON.stringify(p),
      ...(headline ? { headline } : {}),
    });

  app.action("confirm_move", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const raw = JSON.parse(action.value ?? "{}") as MovePayload & {
      ns: number;
      ne: number;
    };
    const actorId = body.user.id;
    const anchor = anchorOf(body);
    const asUser = await deps.emailOf(raw.req.u);
    const result = await moveBooking(
      { calendar: deps.calendar },
      { actorId, eventId: raw.eventId, newStart: raw.ns, newEnd: raw.ne, asUser },
    );
    if (result.ok) {
      const moved: MovePayload = { ...raw, s: raw.ns, e: raw.ne };
      await client.chat.update({
        channel: anchor.channel,
        ts: anchor.ts,
        text: "회의를 옮겼어요.",
        blocks: renderDone(moved, "옮겼어요. 참석자에게 변경 알림이 갑니다."),
      });
      await client.chat.postMessage({
        channel: anchor.channel,
        thread_ts: anchor.ts,
        text: `:arrows_counterclockwise: <@${actorId}> 님이 변경 — ${fmtSlot(raw.s, raw.e)} → ${fmtSlot(raw.ns, raw.ne)}`,
      });
      notifyAttendees(
        client,
        raw.req.a,
        actorId,
        `:arrows_counterclockwise: <@${actorId}> 님이 회의 시간을 옮겼어요 — *${raw.req.t}*\n${fmtSlot(raw.s, raw.e)} → ${fmtSlot(raw.ns, raw.ne)}`,
      );
    } else {
      // 실패 — 카드를 원래 완료 상태로 되돌리고 히스토리에 남긴다
      await client.chat.update({
        channel: anchor.channel,
        ts: anchor.ts,
        text: "이동에 실패했어요.",
        blocks: renderDone(raw),
      });
      await client.chat.postMessage({
        channel: anchor.channel,
        thread_ts: anchor.ts,
        text: `:x: 이동 실패 (사유: ${result.reason}) — 캘린더에서 직접 조정해 주세요.`,
      });
    }
  });

  // [그대로 두기] — 카드를 완료 상태로 복원
  app.action("abort_move", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const p = JSON.parse(action.value ?? "{}") as MovePayload;
    const anchor = anchorOf(body);
    await client.chat.update({
      channel: anchor.channel,
      ts: anchor.ts,
      text: "그대로 뒀어요.",
      blocks: renderDone(p),
    });
  });

  // URL 버튼 클릭 ack (링크는 브라우저가 처리)
  app.action("noop_link", async ({ ack }) => {
    await ack();
  });
}
