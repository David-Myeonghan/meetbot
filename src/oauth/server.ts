import { createServer } from "node:http";
import { google } from "googleapis";
import type { UserStore } from "../store/users.js";

/**
 * OAuth 콜백 — 개인 동의 모델의 연동 처리.
 * 최소 권한 스코프: 빈 시간 조회(freebusy) + 이벤트 생성·관리(events).
 * 캘린더 전체 읽기(readonly)는 요청하지 않는다 — 제목·내용을 읽지 않는 설계.
 */

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

export function authUrlFor(slackUserId: string, email: string): string {
  const auth = oauthClient();
  return auth.generateAuthUrl({
    access_type: "offline", // refresh token — 다음 요청부터 재동의 없이 대행
    prompt: "consent",
    scope: SCOPES,
    state: JSON.stringify({ u: slackUserId, e: email }),
  });
}

function oauthClient() {
  return new google.auth.OAuth2(
    process.env["GOOGLE_CLIENT_ID"],
    process.env["GOOGLE_CLIENT_SECRET"],
    process.env["GOOGLE_OAUTH_REDIRECT"],
  );
}

export function startOAuthServer(store: UserStore): void {
  const redirect = process.env["GOOGLE_OAUTH_REDIRECT"] ?? "http://localhost:3355/oauth/callback";
  const port = Number(new URL(redirect).port || 3355);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== new URL(redirect).pathname) {
      res.writeHead(404).end();
      return;
    }
    try {
      const code = url.searchParams.get("code");
      const state = JSON.parse(url.searchParams.get("state") ?? "{}") as {
        u?: string;
        e?: string;
      };
      if (!code || !state.u || !state.e) throw new Error("잘못된 콜백");
      const auth = oauthClient();
      const { tokens } = await auth.getToken(code);
      if (!tokens.refresh_token) throw new Error("refresh token 없음 — 재동의 필요");
      store.saveToken(state.u, state.e, tokens.refresh_token);
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<h3>연동 완료 — 슬랙으로 돌아가 /meet 를 다시 실행하세요.</h3>");
    } catch (e) {
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(`<h3>연동 실패: ${e instanceof Error ? e.message : "unknown"}</h3>`);
    }
  });
  server.listen(port, () => {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), msg: `OAuth 콜백 대기 :${port}` }),
    );
  });
}
