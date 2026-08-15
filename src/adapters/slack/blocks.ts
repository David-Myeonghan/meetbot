import type { KnownBlock, View } from "@slack/types";
import type { Candidate } from "../../domain/types.js";

/**
 * Block Kit 선언 — 우리는 블록을 선언하고, 그리는 것은 슬랙이다.
 * 대화 상태(후보 슬롯·요청 ID·이벤트 ID)는 버튼 value/private_metadata에 실어 왕복시킨다.
 */

const KST = "Asia/Seoul";

function fmtSlot(start: number, end: number): string {
  const day = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(start));
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} ${time.format(new Date(start))}–${time.format(new Date(end))}`;
}

/** 폼 모달 — 요청 스키마 {참석자, 소요 시간, 기간 창, 회의실 필요 여부} + 제목 */
export function meetingForm(): View {
  return {
    type: "modal",
    callback_id: "meet_form",
    title: { type: "plain_text", text: "회의 잡기" },
    submit: { type: "plain_text", text: "빈 시간 찾기" },
    close: { type: "plain_text", text: "닫기" },
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: { type: "plain_text", text: "회의 제목" },
        element: {
          type: "plain_text_input",
          action_id: "v",
          placeholder: { type: "plain_text", text: "예: 주간 싱크" },
        },
      },
      {
        type: "input",
        block_id: "attendees",
        label: { type: "plain_text", text: "참석자" },
        element: {
          type: "multi_users_select",
          action_id: "v",
          placeholder: { type: "plain_text", text: "참석자 선택" },
        },
      },
      {
        type: "input",
        block_id: "duration",
        label: { type: "plain_text", text: "소요 시간" },
        element: {
          type: "static_select",
          action_id: "v",
          initial_option: {
            text: { type: "plain_text", text: "30분" },
            value: "30",
          },
          options: [
            { text: { type: "plain_text", text: "30분" }, value: "30" },
            { text: { type: "plain_text", text: "1시간" }, value: "60" },
            { text: { type: "plain_text", text: "1시간 30분" }, value: "90" },
          ],
        },
      },
      {
        type: "input",
        block_id: "window",
        label: { type: "plain_text", text: "기간 창" },
        element: {
          type: "static_select",
          action_id: "v",
          initial_option: {
            text: { type: "plain_text", text: "5영업일 안" },
            value: "5",
          },
          options: [
            { text: { type: "plain_text", text: "오늘·내일" }, value: "2" },
            { text: { type: "plain_text", text: "5영업일 안" }, value: "5" },
            { text: { type: "plain_text", text: "2주 안" }, value: "10" },
          ],
        },
      },
      {
        type: "input",
        block_id: "room",
        optional: true,
        label: { type: "plain_text", text: "회의실" },
        element: {
          type: "checkboxes",
          action_id: "v",
          options: [
            {
              text: { type: "plain_text", text: "회의실 필요 (인원에 맞는 가장 작은 빈 방을 자동으로 잡습니다)" },
              value: "needs_room",
            },
          ],
        },
      },
    ],
  };
}

/** 후보 카드 — 버튼 value에 슬롯과 요청 ID를 실어 보낸다 (서버 무상태) */
export function candidateCard(
  candidates: Candidate[],
  payloadFor: (c: Candidate) => string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*이 시간이면 전원 가능해요.* 하나를 고르면 초대 발송까지 한 번에 잡습니다.",
      },
    },
    ...candidates.map<KnownBlock>((c) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${fmtSlot(c.start, c.end)}*${c.room ? `  ·  ${c.room.name}` : ""}`,
      },
      accessory: {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "이 시간으로 잡기" },
        action_id: "create_meeting",
        value: payloadFor(c),
      },
    })),
  ];
}

/** 완료 카드 — 이벤트 ID를 버튼에 심어 취소·변경이 무상태로 동작 */
export function doneCard(params: {
  title: string;
  start: number;
  end: number;
  roomName?: string;
  eventId: string;
  htmlLink?: string;
  movePayload: string;
}): KnownBlock[] {
  const where = params.roomName ? `  ·  ${params.roomName}` : "";
  const link = params.htmlLink ? `\n<${params.htmlLink}|캘린더에서 보기>` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *${params.title}* 잡았어요.\n${fmtSlot(params.start, params.end)}${where}${link}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "취소" },
          style: "danger",
          action_id: "cancel_meeting",
          value: params.eventId,
          confirm: {
            title: { type: "plain_text", text: "회의 취소" },
            text: { type: "plain_text", text: "초대를 회수하고 회의실을 반납합니다." },
            confirm: { type: "plain_text", text: "취소하기" },
            deny: { type: "plain_text", text: "그대로 두기" },
          },
        },
        {
          type: "button",
          text: { type: "plain_text", text: "시간 변경" },
          action_id: "move_meeting",
          value: params.movePayload,
        },
      ],
    },
  ];
}

/** 실패 카드 — 사유와 다음 행동. 침묵하는 dead end 금지 */
export function failCard(reason: string, nextAction: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: ${reason}\n→ ${nextAction}`,
      },
    },
  ];
}
