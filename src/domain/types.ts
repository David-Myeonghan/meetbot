/** 요청 스키마 — 입력 수단과 예약 로직 사이의 계약. 나중에 자연어 파서를 얹는 지점. */
export interface MeetingRequest {
  /** 요청자 슬랙 user ID */
  requesterId: string;
  /** 참석자 슬랙 user ID 목록 (요청자 포함) */
  attendeeIds: string[];
  /** 소요 시간 (분) */
  durationMinutes: number;
  /** 탐색 창 시작 (epoch ms) */
  windowStart: number;
  /** 탐색 창 끝 (epoch ms) */
  windowEnd: number;
  /** 회의실 필요 여부 */
  needsRoom: boolean;
  /** 회의 제목 */
  title: string;
}

/** 중립 모델: 바쁜 구간. 벤더 응답을 어댑터가 이 형태로 정규화해 올린다. */
export interface BusyInterval {
  start: number; // epoch ms
  end: number;   // epoch ms
  /** 벤더가 '미정(tentative)'을 주는 경우 라벨째 올린다 — 바쁨으로 칠지는 코어의 정책 */
  tentative?: boolean;
}

/** 사람별 바쁜 구간 목록 */
export type BusyByPerson = Map<string, BusyInterval[]>;

export interface Room {
  id: string;
  name: string;
  capacity: number;
}

/** 엔진이 내미는 후보 */
export interface Candidate {
  start: number;
  end: number;
  room?: Room;
}

/** 중립 에러 타입 — 벤더 에러를 어댑터가 이 타입으로 번역한다 */
export type CalendarErrorKind =
  | "no_permission"
  | "slot_taken"     // 요청 ID 중복 또는 선점
  | "rate_limited"
  | "not_found"
  | "unknown";

export class CalendarError extends Error {
  constructor(
    public kind: CalendarErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

export interface CreatedEvent {
  eventId: string;
  htmlLink?: string;
}
