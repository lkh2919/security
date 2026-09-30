/**
 * Korean-name heuristics (best effort). Names are only masked when a context proves them: speaker label,
 * self-introduction, titled mention, form owner field, or `knownNames`.
 */

const SURNAMES_2 = ["남궁", "황보", "제갈", "선우", "독고", "사공", "서문", "동방"];
const SURNAMES_1 =
  "김이박최정강조윤장임한오서신권황안송류유홍전고문양손배백허남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉";
export const SURNAME_ALT = `(?:${SURNAMES_2.join("|")}|[${SURNAMES_1}])`;
/** Surname + 1-2 given-name syllables. */
export const NAME_RE_SRC = `${SURNAME_ALT}[가-힣]{1,2}`;

const GU = "강남 서초 송파 강동 강서 마포 영등포 용산 성동 광진 동작 관악 금천 구로 양천 노원 도봉 강북 성북 종로 서대문 은평 동대문 중랑"
  .split(" ")
  .map((g) => `${g}구`);

/** Common nouns that start with a surname syllable. Never treated as names. */
const STOP = new Set(
  (
    "이용 이용자 이메일 이름 이상 이하 이후 이전 이번 이슈 이벤트 이미지 이력 이관 이동 이체 이사 이유 이외 이내 " +
    "정보 정보주체 정책 정상 정도 정산 정확 정지 정기 정리 정의 정말 조회 조건 조직 조치 조사 조합 조정 주소 주문 주문자 주민 주요 주기 주로 주체 주간 " +
    "장바구니 장애 장기 장점 전화 전송 전송자 전체 전달 전환 전자 전문 전용 전사 제공 제공자 제휴 제품 제출 제한 최근 최소 최대 최종 " +
    "한국 한도 한번 한정 한글 한편 고객 고객사 고유 고정 고려 공유 공개 공통 공급 공지 구매 구매자 구독 구분 구성 구현 권한 권장 권고 " +
    "강제 강화 서비스 서버 서명 설정 설계 설치 신용 신청 신원 신규 신고 신뢰 신분 송금 송신 문의 문자 문서 문제 문구 문의처 " +
    "임의 임시 임직원 유저 유효 유지 유출 유형 안내 안전 안정 양식 양쪽 연락 연동 연락처 여부 여기 오류 오늘 오프라인 우리 우선 우편 " +
    "원본 원칙 원천 위탁 위치 위험 위반 인증 인터뷰 인터뷰어 인터뷰이 인사 인원 인력 기간 기록 기본 기능 기획 기획자 기준 기업 " +
    "도입 도메인 노출 노트 나이 나중 하나 하위 하지 허용 허가 백업 백엔드 배송 배달 배포 배치 차단 차량 차이 채널 채용 천천히 " +
    "방식 방법 방문 방침 변경 변수 반드시 반영 반환 심사 심의 성별 성명 성능 성함 성공 성인 진행 진단 지원 지금 지정 지연 지속 지침 " +
    "마케팅 마스킹 마이 민감 민원 모두 모바일 모델 목적 목록 목표 명시 명확 명칭 표시 표준 함께 현재 현황 현장 홍보 추가 추정 추후 " +
    "소셜 소유 소프트 석사 박사 은행 경우 경로 예약 예외 예정 용도 용어 왕복 금액 금융 국내 국외 어떤 어플 어디 편의 봉사 사이 " +
    GU.join(" ")
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Structural endings that mark words (team, dept, region...) rather than personal names. */
const NON_NAME_ENDING = /[팀부실별적시군읍면로길역]$/;

export const TITLES_ANY =
  "님|씨|선생님|선생|팀장|과장|차장|부장|대리|사원|주임|매니저|책임|선임|수석|리드|개발자|기획자|디자이너|대표|이사|상무|전무|실장|본부장|센터장|파트장|담당자|담당|교수|박사|CTO|CPO|CEO|PM|PO";
export const TITLES_HONORIFIC = "님|씨|선생님";

export function isPlausibleKoreanName(s: string, extraStop?: ReadonlySet<string>): boolean {
  if (!new RegExp(`^${NAME_RE_SRC}$`).test(s)) return false;
  if (STOP.has(s) || extraStop?.has(s)) return false;
  if (NON_NAME_ENDING.test(s)) return false;
  if (s.length === 4 && s.endsWith("구")) return false;
  return true;
}

export const NAME_PARTICLES =
  "이라고|이라는|이랑|이가|이는|이도|이를|이의|이에게|이한테|이란|이었|이다|입니다|이|가|은|는|을|를|와|과|의|도|에게|한테|께서|께|랑|으로|로|에서|에|만|님|씨|란|라고|라는|였";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tracks names proven by context and builds the replacement regexes. */
export class NameBook {
  private readonly full = new Set<string>();
  private readonly given = new Set<string>();
  private readonly extraStop: Set<string>;
  private cache: { full: RegExp | null; given: RegExp | null } | null = null;

  constructor(extraStop: readonly string[] = []) {
    this.extraStop = new Set(extraStop);
  }

  /** Registers a name unconditionally (caller vouches for it). */
  addKnown(name: string): void {
    const n = name.normalize("NFKC").trim();
    if (n.length < 2) return;
    this.full.add(n);
    if (/^[가-힣]{3}$/.test(n)) {
      const g = n.slice(1);
      if (!STOP.has(g) && !this.extraStop.has(g)) this.given.add(g);
    }
    this.cache = null;
  }

  /** Registers a name only if it looks like a Korean personal name. Returns whether it was accepted. */
  addIfPlausible(name: string): boolean {
    const n = name.normalize("NFKC").trim();
    if (!isPlausibleKoreanName(n, this.extraStop) || this.given.has(n)) return false; // given-name-only mentions map to the known full name
    this.addKnown(n);
    return true;
  }

  /** Finds names introduced by context in already structurally-masked text. */
  discover(text: string): void {
    const intro = new RegExp(
      `(?:저는|제\\s*이름은|이름은|성함은|성함이|담당자는|담당자|제가)\\s*(${NAME_RE_SRC})(?=\\s*(?:입니다|이에요|예요|이고|이라고|라고|이며|이구요|[,.!?]|$))`,
      "gm",
    );
    const titled3 = new RegExp(`(?<![가-힣])(${SURNAME_ALT}[가-힣]{2})(?=\\s*(?:${TITLES_ANY}))`, "g");
    const titled2 = new RegExp(`(?<![가-힣])(${SURNAME_ALT}[가-힣])(?=\\s*(?:${TITLES_HONORIFIC}))`, "g");
    for (const re of [intro, titled3, titled2]) for (const m of text.matchAll(re)) this.addIfPlausible(m[1]);
  }

  private build(): { full: RegExp | null; given: RegExp | null } {
    if (this.cache) return this.cache;
    const fullList = [...this.full];
    const alts = fullList.sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe);
    const givens = [...this.given].filter((g) => !this.full.has(g)).sort().map(escapeRe);
    this.cache = {
      full: alts.length ? new RegExp(`(?<![가-힣A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])(?=$|[^가-힣]|(?:${NAME_PARTICLES}))`, "gi") : null,
      given: givens.length ? new RegExp(`(?<![가-힣A-Za-z0-9])(?:${givens.join("|")})(?=\\s*(?:님|씨))`, "g") : null,
    };
    return this.cache;
  }

  /** Replaces every registered name; `repl(matched, isGivenOnly)` supplies the placeholder. */
  apply(text: string, repl: (matched: string, givenOnly: boolean) => string): string {
    const { full, given } = this.build();
    let t = text;
    if (full) t = t.replace(full, (m) => repl(m, false));
    if (given) t = t.replace(given, (m) => repl(m, true));
    return t;
  }

  /** Full name a given-only mention belongs to. */
  fullFor(givenOnly: string): string | undefined {
    return [...this.full].sort().find((f) => f.length === 3 && f.endsWith(givenOnly));
  }
}
