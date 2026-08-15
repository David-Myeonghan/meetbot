import type {
  BusyByPerson,
  BusyInterval,
  Candidate,
  Room,
} from "../domain/types.js";

/**
 * 가용성 엔진 — 읽기 경로의 본체. 순수 함수.
 * 같은 입력이면 같은 후보가 나온다 (재현·감사 가능, LLM에 맡기지 않는 이유).
 *
 * 계산: 탐색 창∩근무시간에서 바쁜 구간을 빼 사람별 빈 구간을 만들고,
 * 전원의 빈 구간을 겹쳐 교집합을 구한 뒤, 소요 시간 이상 남는 자리를
 * 정각·30분 경계에 맞춰 잘라 이른 순으로 후보를 뽑는다.
 */

export interface EngineOptions {
  /** 근무 시작 시각 (현지 기준 시) */
  workStartHour: number;
  /** 근무 끝 시각 */
  workEndHour: number;
  /** 후보 최대 개수 */
  maxCandidates: number;
  /** 후보 정렬 경계 (분) — 정각과 30분 */
  boundaryMinutes: number;
  /** 타임존 — v1은 단일 조직 가정 */
  timeZone: string;
  /** 미정(tentative) 일정을 바쁨으로 칠 것인가 — 코어의 정책 (기본: 바쁨) */
  treatTentativeAsBusy: boolean;
}

export const defaultOptions: EngineOptions = {
  workStartHour: 10,
  workEndHour: 18,
  maxCandidates: 3,
  boundaryMinutes: 30,
  timeZone: "Asia/Seoul",
  treatTentativeAsBusy: true,
};

interface Interval {
  start: number;
  end: number;
}

const MS_PER_MIN = 60_000;

/** 타임존 기준 그 날의 특정 시(hour) epoch ms */
function zonedHour(dayAnchor: number, hour: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(dayAnchor));
  // parts = "YYYY-MM-DD" — 그 날짜의 hour시를 타임존 오프셋으로 계산
  const utcGuess = Date.parse(`${parts}T${String(hour).padStart(2, "0")}:00:00Z`);
  // 타임존 오프셋 보정: 같은 벽시계 시각의 UTC 표기와 실제 표기 차이
  const offsetMs = tzOffsetMs(utcGuess, timeZone);
  return utcGuess - offsetMs;
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.parse(
    `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"] === "24" ? "00" : parts["hour"]}:${parts["minute"]}:${parts["second"]}Z`,
  );
  return asUtc - utcMs;
}

/** 탐색 창을 일 단위 근무시간 구간들로 자른다 (주말 제외) */
export function workWindows(
  windowStart: number,
  windowEnd: number,
  opt: EngineOptions,
): Interval[] {
  const windows: Interval[] = [];
  // 하루씩 전진하며 근무 구간 생성
  for (
    let cursor = windowStart;
    cursor < windowEnd;
    cursor += 24 * 60 * MS_PER_MIN
  ) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: opt.timeZone,
      weekday: "short",
    }).format(new Date(cursor));
    if (weekday === "Sat" || weekday === "Sun") continue;
    const dayStart = zonedHour(cursor, opt.workStartHour, opt.timeZone);
    const dayEnd = zonedHour(cursor, opt.workEndHour, opt.timeZone);
    const start = Math.max(dayStart, windowStart);
    const end = Math.min(dayEnd, windowEnd);
    if (start < end) windows.push({ start, end });
  }
  return windows;
}

/** 구간 목록 정규화: 정렬 + 병합 */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** base 구간들에서 busy 구간들을 뺀다 */
function subtract(base: Interval[], busy: Interval[]): Interval[] {
  const mergedBusy = mergeIntervals(busy);
  const result: Interval[] = [];
  for (const b of base) {
    let cursor = b.start;
    for (const bz of mergedBusy) {
      if (bz.end <= cursor || bz.start >= b.end) continue;
      if (bz.start > cursor) result.push({ start: cursor, end: bz.start });
      cursor = Math.max(cursor, bz.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) result.push({ start: cursor, end: b.end });
  }
  return result;
}

/** 두 구간 목록의 교집합 */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i]!;
    const bj = b[j]!;
    const start = Math.max(ai.start, bj.start);
    const end = Math.min(ai.end, bj.end);
    if (start < end) result.push({ start, end });
    if (ai.end < bj.end) i++;
    else j++;
  }
  return result;
}

/** 빈 구간에서 소요 시간 이상 자리를 30분 경계로 잘라 후보 시각들을 뽑는다 */
function sliceCandidates(
  free: Interval[],
  durationMinutes: number,
  opt: EngineOptions,
): Interval[] {
  const durMs = durationMinutes * MS_PER_MIN;
  const stepMs = opt.boundaryMinutes * MS_PER_MIN;
  const out: Interval[] = [];
  for (const iv of free) {
    // 경계 올림
    let start = Math.ceil(iv.start / stepMs) * stepMs;
    while (start + durMs <= iv.end) {
      out.push({ start, end: start + durMs });
      start += stepMs;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function toBusy(
  intervals: BusyInterval[],
  opt: EngineOptions,
): Interval[] {
  return intervals
    .filter((iv) => (iv.tentative ? opt.treatTentativeAsBusy : true))
    .map(({ start, end }) => ({ start, end }));
}

/**
 * 회의실 선택: 후보 시간대에 비어 있는 방 중 참석 인원 이상, 가장 작은 방.
 * "아무 방"이 아닌 이유 — 회의실 품귀의 주범은 크기 미스매치.
 * 작은 방이 다 차서 큰 방만 남았으면 그중 최소를 그대로 잡는다 (조율이 공간 효율보다 우선).
 */
export function pickRoom(
  rooms: Room[],
  roomBusy: Map<string, Interval[]>,
  slot: Interval,
  headcount: number,
): Room | undefined {
  const fits = rooms
    .filter((r) => r.capacity >= headcount)
    .sort((a, b) => a.capacity - b.capacity);
  for (const room of fits) {
    const busy = roomBusy.get(room.id) ?? [];
    const overlaps = busy.some(
      (b) => b.start < slot.end && b.end > slot.start,
    );
    if (!overlaps) return room;
  }
  return undefined;
}

export interface FindCandidatesInput {
  busyByPerson: BusyByPerson;
  durationMinutes: number;
  windowStart: number;
  windowEnd: number;
  rooms?: Room[];
  roomBusy?: Map<string, Interval[]>;
  headcount?: number;
  needsRoom?: boolean;
}

/** 엔진 진입점 */
export function findCandidates(
  input: FindCandidatesInput,
  opt: EngineOptions = defaultOptions,
): Candidate[] {
  const base = workWindows(input.windowStart, input.windowEnd, opt);

  // 사람별 빈 구간 → 전원 교집합
  let common: Interval[] = base;
  for (const intervals of input.busyByPerson.values()) {
    const personFree = subtract(base, toBusy(intervals, opt));
    common = intersect(common, personFree);
    if (common.length === 0) break;
  }

  const slots = sliceCandidates(common, input.durationMinutes, opt);

  const out: Candidate[] = [];
  for (const slot of slots) {
    if (out.length >= opt.maxCandidates) break;
    if (input.needsRoom) {
      const room = pickRoom(
        input.rooms ?? [],
        input.roomBusy ?? new Map(),
        slot,
        input.headcount ?? input.busyByPerson.size,
      );
      if (!room) continue; // 방 없는 슬롯은 후보에서 제외
      out.push({ ...slot, room });
    } else {
      out.push({ ...slot });
    }
  }
  return out;
}

/** 실패 사유 — 침묵하는 dead end 금지: 사유와 다음 행동을 돌려준다 */
export type NoCandidateReason =
  | "no_common_free" // 공통 빈 시간 자체가 없음 → 기간을 넓히거나 인원 조정
  | "no_room";       // 시간은 있는데 방이 없음 → 회의실 없이 잡거나 기간 확장

export function diagnoseEmpty(
  input: FindCandidatesInput,
  opt: EngineOptions = defaultOptions,
): NoCandidateReason {
  const withoutRoom = findCandidates(
    { ...input, needsRoom: false },
    opt,
  );
  return withoutRoom.length > 0 ? "no_room" : "no_common_free";
}
