import { describe, expect, it } from "vitest";
import {
  defaultOptions,
  diagnoseEmpty,
  findCandidates,
  pickRoom,
  workWindows,
} from "./availability.js";
import type { BusyByPerson, Room } from "../domain/types.js";

// 기준일: 2026-08-17(월) Asia/Seoul. 근무 10~18시.
const KST = "+09:00";
const t = (iso: string) => Date.parse(`${iso}${KST}`);

const MON = "2026-08-17";
const TUE = "2026-08-18";

const opt = { ...defaultOptions };

describe("workWindows", () => {
  it("주말을 건너뛰고 근무시간만 자른다", () => {
    // 금(8/21)~월(8/24) 창 → 금, 월 이틀
    const windows = workWindows(t("2026-08-21T00:00"), t("2026-08-25T00:00"), opt);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.start).toBe(t("2026-08-21T10:00"));
    expect(windows[0]!.end).toBe(t("2026-08-21T18:00"));
    expect(windows[1]!.start).toBe(t("2026-08-24T10:00"));
  });

  it("창 경계가 근무시간 중간이면 잘린다", () => {
    const windows = workWindows(t(`${MON}T13:00`), t(`${MON}T23:00`), opt);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.start).toBe(t(`${MON}T13:00`));
    expect(windows[0]!.end).toBe(t(`${MON}T18:00`));
  });
});

describe("findCandidates", () => {
  it("전원 빈 시간의 교집합에서 이른 순 3개를 30분 경계로 뽑는다", () => {
    const busy: BusyByPerson = new Map([
      // A: 월 10~12 바쁨
      ["a@x.com", [{ start: t(`${MON}T10:00`), end: t(`${MON}T12:00`) }]],
      // B: 월 13~14 바쁨
      ["b@x.com", [{ start: t(`${MON}T13:00`), end: t(`${MON}T14:00`) }]],
    ]);
    const out = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: 30,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${MON}T23:59`),
      },
      opt,
    );
    expect(out).toHaveLength(3);
    // 공통 빈 시간: 12~13, 14~18 → 이른 순 12:00, 12:30, 14:00
    expect(out[0]!.start).toBe(t(`${MON}T12:00`));
    expect(out[1]!.start).toBe(t(`${MON}T12:30`));
    expect(out[2]!.start).toBe(t(`${MON}T14:00`));
  });

  it("바쁜 구간이 어중간하게 끝나면 다음 30분 경계로 올린다", () => {
    const busy: BusyByPerson = new Map([
      ["a@x.com", [{ start: t(`${MON}T10:00`), end: t(`${MON}T10:40`) }]],
    ]);
    const out = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: 60,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${MON}T23:59`),
      },
      opt,
    );
    // 10:40 이후 첫 경계는 11:00
    expect(out[0]!.start).toBe(t(`${MON}T11:00`));
  });

  it("미정(tentative)은 기본 정책상 바쁨으로 친다", () => {
    const busy: BusyByPerson = new Map([
      ["a@x.com", [{ start: t(`${MON}T10:00`), end: t(`${MON}T12:00`), tentative: true }]],
    ]);
    const out = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: 30,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${MON}T13:00`),
      },
      opt,
    );
    expect(out[0]!.start).toBe(t(`${MON}T12:00`));
  });

  it("같은 입력이면 같은 후보 (결정론)", () => {
    const busy: BusyByPerson = new Map([
      ["a@x.com", [{ start: t(`${MON}T11:00`), end: t(`${MON}T15:00`) }]],
    ]);
    const input = {
      busyByPerson: busy,
      durationMinutes: 45,
      windowStart: t(`${MON}T00:00`),
      windowEnd: t(`${TUE}T23:59`),
    };
    expect(findCandidates(input, opt)).toEqual(findCandidates(input, opt));
  });

  it("회의실 필요 시 인원 이상 중 가장 작은 빈 방을 붙인다", () => {
    const rooms: Room[] = [
      { id: "r8", name: "큰방", capacity: 8 },
      { id: "r4", name: "중간방", capacity: 4 },
      { id: "r2", name: "작은방", capacity: 2 },
    ];
    const busy: BusyByPerson = new Map([
      ["a@x.com", []],
      ["b@x.com", []],
      ["c@x.com", []],
    ]);
    const out = findCandidates(
      {
        busyByPerson: busy,
        durationMinutes: 30,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${MON}T23:59`),
        rooms,
        roomBusy: new Map(),
        headcount: 3,
        needsRoom: true,
      },
      opt,
    );
    // 3명 → capacity 4가 최소 적합 (2는 부족, 8은 과대)
    expect(out[0]!.room?.id).toBe("r4");
  });

  it("작은 방이 차 있으면 남은 방 중 최소를 그대로 잡는다 (되묻지 않음)", () => {
    const rooms: Room[] = [
      { id: "r8", name: "큰방", capacity: 8 },
      { id: "r2", name: "작은방", capacity: 2 },
    ];
    const roomBusy = new Map([
      ["r2", [{ start: t(`${MON}T00:00`), end: t(`${TUE}T00:00`) }]],
    ]);
    const room = pickRoom(
      rooms,
      roomBusy,
      { start: t(`${MON}T10:00`), end: t(`${MON}T10:30`) },
      2,
    );
    expect(room?.id).toBe("r8");
  });
});

describe("diagnoseEmpty", () => {
  it("시간은 있는데 방이 없으면 no_room", () => {
    const busy: BusyByPerson = new Map([["a@x.com", []]]);
    const reason = diagnoseEmpty(
      {
        busyByPerson: busy,
        durationMinutes: 30,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${MON}T23:59`),
        rooms: [],
        needsRoom: true,
      },
      opt,
    );
    expect(reason).toBe("no_room");
  });

  it("공통 빈 시간 자체가 없으면 no_common_free", () => {
    const busy: BusyByPerson = new Map([
      ["a@x.com", [{ start: t(`${MON}T00:00`), end: t(`${TUE}T23:59`) }]],
    ]);
    const reason = diagnoseEmpty(
      {
        busyByPerson: busy,
        durationMinutes: 30,
        windowStart: t(`${MON}T00:00`),
        windowEnd: t(`${TUE}T23:59`),
      },
      opt,
    );
    expect(reason).toBe("no_common_free");
  });
});
