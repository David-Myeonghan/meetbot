import type {
  BusyByPerson,
  CreatedEvent,
  Room,
} from "../../domain/types.js";

/**
 * 캘린더 포트 — 어댑터는 번역만 하고 판단하지 않는다.
 * "이 캘린더를 저 캘린더로 바꿀 때 같이 버려져야 하는 코드"만 어댑터에 산다.
 */
export interface CalendarPort {
  /** 사람들(이메일)의 바쁜 구간을 중립 모델로 정규화해 반환 */
  getBusy(
    emails: string[],
    windowStart: number,
    windowEnd: number,
    /** 조회 주체(요청자) — 위임 토큰의 소유자 */
    asUser: string,
  ): Promise<BusyByPerson>;

  /** 회의실 목록 (정원 포함). 없으면 빈 배열 */
  listRooms(asUser: string): Promise<Room[]>;

  /**
   * 이벤트 생성. requestId가 같으면 중복 생성이 캘린더에서 걸러진다(멱등 위임).
   * 회의실은 리소스 참석자로 첨부 — 예약·반납이 캘린더에서 자동 처리된다.
   */
  createEvent(params: {
    requestId: string;
    title: string;
    start: number;
    end: number;
    attendeeEmails: string[];
    roomEmail?: string;
    asUser: string;
  }): Promise<CreatedEvent>;

  /**
   * 방(리소스 참석자)의 수락 상태. 리소스 캘린더는 충돌 시 사후에 자동 거절하므로
   * 생성 직후 이 값을 재조회해 "완료 카드는 떴는데 방은 없는" 사고를 봇이 스스로 잡는다.
   */
  roomResponse(
    eventId: string,
    roomEmail: string,
    asUser: string,
  ): Promise<"accepted" | "declined" | "pending">;

  cancelEvent(eventId: string, asUser: string): Promise<void>;

  moveEvent(
    eventId: string,
    newStart: number,
    newEnd: number,
    asUser: string,
  ): Promise<void>;
}
