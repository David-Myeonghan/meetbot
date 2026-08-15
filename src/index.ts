import "dotenv/config";
import bolt from "@slack/bolt";
import { FakeCalendar } from "./adapters/calendar/fake.js";
import type { CalendarPort } from "./adapters/calendar/port.js";
import { registerHandlers } from "./adapters/slack/handlers.js";
import { defaultOptions } from "./engine/availability.js";

const { App } = bolt;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 이(가) 필요합니다. .env.example 참조`);
  return v;
}

async function main(): Promise<void> {
  const app = new App({
    token: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
    socketMode: true, // 사내 전용 — 공개 URL 없이 WebSocket으로 수신
  });

  const adapterKind = process.env["CALENDAR_ADAPTER"] ?? "fake";
  let calendar: CalendarPort;
  let authUrlFor: ((userId: string, email: string) => string) | undefined;
  if (adapterKind === "google") {
    const { GoogleCalendar } = await import("./adapters/calendar/google.js");
    const { UserStore } = await import("./store/users.js");
    const { authUrlFor: makeAuthUrl, startOAuthServer } = await import(
      "./oauth/server.js"
    );
    const store = new UserStore(required("TOKEN_ENC_KEY"));
    calendar = new GoogleCalendar(store);
    authUrlFor = makeAuthUrl;
    // 연동 완료 시 연동 카드를 제자리 갱신 (카드 = 항상 현재 상태)
    startOAuthServer(store, async ({ cardChannel, cardTs }) => {
      if (!cardChannel || !cardTs) return;
      await app.client.chat.update({
        channel: cardChannel,
        ts: cardTs,
        text: "연동 완료",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":white_check_mark: *캘린더 연동 완료* — 이제 `/meet` 한 번으로 바로 잡을 수 있어요.",
            },
          },
        ],
      });
    });
  } else {
    const fake = new FakeCalendar(new URL("../data/fake-calendar.json", import.meta.url).pathname);
    calendar = fake;
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "가짜 캘린더 어댑터로 동작 — CALENDAR_ADAPTER=google로 실제 전환" }));
  }

  // 슬랙 user ID → 캘린더 이메일 (사내: 프로필 이메일 = 캘린더 계정)
  const emailCache = new Map<string, string>();
  const emailOf = async (userId: string): Promise<string> => {
    const hit = emailCache.get(userId);
    if (hit) return hit;
    const res = await app.client.users.info({ user: userId });
    const email = res.user?.profile?.email ?? `${userId}@unknown.local`;
    emailCache.set(userId, email);
    return email;
  };

  // 확산 훅 — 전사 오픈 단계 기능 (ENABLE_SPREAD=true + google 어댑터일 때만)
  let spread: ((attendeeIds: string[], requesterId: string) => Promise<void>) | undefined;
  if (process.env["ENABLE_SPREAD"] === "true" && adapterKind === "google") {
    const { UserStore } = await import("./store/users.js");
    const { authUrlFor: makeAuthUrl } = await import("./oauth/server.js");
    const store = new UserStore(required("TOKEN_ENC_KEY"));
    const { audit } = await import("./audit/log.js");
    spread = async (attendeeIds, requesterId) => {
      for (const id of attendeeIds) {
        if (id === requesterId) continue;
        const email = await emailOf(id);
        // 미연동·미발송·미옵트아웃에게만, 한 번만 — 미연동 여부는 본인 외 누구에게도 노출되지 않는다
        if (!store.shouldNudge(id) || store.isLinked(email)) continue;
        await app.client.chat.postMessage({
          channel: id,
          text: "방금 이 회의는 회의봇으로 잡혔어요.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*방금 이 회의는 회의봇으로 잡혔어요.*\n연동하면 `/meet` 한 번으로 똑같이 잡을 수 있어요.",
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
                  url: makeAuthUrl(id, email),
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "알림 안 받기" },
                  action_id: "spread_opt_out",
                  value: id,
                },
              ],
            },
          ],
        });
        store.markNudged(id, email);
        audit({ actor: requesterId, action: "spread_nudge_sent" });
      }
    };
    app.action("spread_opt_out", async ({ ack, body, respond }) => {
      await ack();
      store.optOut(body.user.id);
      await respond({ replace_original: true, text: "알겠어요. 다시 알리지 않을게요." });
    });
  }

  registerHandlers(app, {
    calendar,
    engineOptions: {
      ...defaultOptions,
      workStartHour: Number(process.env["WORK_START_HOUR"] ?? 10),
      workEndHour: Number(process.env["WORK_END_HOUR"] ?? 18),
    },
    emailOf,
    ...(authUrlFor ? { authUrlFor } : {}),
    ...(spread ? { spread } : {}),
  });

  await app.start();
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "회의봇 시작 (Socket Mode)" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
