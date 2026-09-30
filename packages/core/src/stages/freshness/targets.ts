import type { FreshnessTargets } from "./run";

/** Default watch list (design R5.6; kb/jurisdictions/kr/statutes/law-targets.json). */
export const DEFAULT_FRESHNESS_TARGETS: FreshnessTargets = {
  laws: [
    { sourceId: "law:pipa", name: "개인정보 보호법", target: "law", lawCode: "PIPA" },
    { sourceId: "law:pipa-decree", name: "개인정보 보호법 시행령", target: "law", lawCode: "DEC" },
    { sourceId: "admrul:std-guideline", name: "표준 개인정보 보호지침", target: "admrul", lawCode: "STDG" },
    { sourceId: "admrul:safety-measures", name: "개인정보의 안전성 확보조치 기준", target: "admrul" },
    { sourceId: "law:artc", name: "약관의 규제에 관한 법률", target: "law" },
    { sourceId: "law:eca", name: "전자상거래 등에서의 소비자보호에 관한 법률", target: "law" },
    { sourceId: "law:eca-decree", name: "전자상거래 등에서의 소비자보호에 관한 법률 시행령", target: "law", lawCode: "ECA-DEC" },
    { sourceId: "law:network-act", name: "정보통신망 이용촉진 및 정보보호 등에 관한 법률", target: "law" },
  ],
  pages: [
    {
      sourceId: "page:pipc-bs217",
      name: "PIPC 처리방침 작성지침 (pipc.go.kr BS217)",
      kind: "pipc-board",
      url: "https://www.pipc.go.kr/np/cop/bbs/selectBoardList.do?bbsId=BS217&mCode=G010030000&schTypeCd=3",
      affectsAllSections: true,
    },
    {
      sourceId: "page:privacy-portal",
      name: "개인정보 포털 처리방침 작성지침 (privacy.go.kr)",
      kind: "privacy-board",
      url: "https://www.privacy.go.kr/front/bbs/bbsList.do?bbsNo=BBSMSTR_000000000049",
      affectsAllSections: true,
    },
    {
      sourceId: "page:ftc-list",
      name: "KFTC 표준약관 목록 (온라인 관련)",
      kind: "ftc-list",
      url: "https://www.ftc.go.kr/www/selectBbsNttList.do?bordCd=201&key=202",
    },
    {
      sourceId: "page:ftc-10023",
      name: "KFTC 전자상거래 표준약관 제10023호",
      kind: "ftc-view",
      url: "https://www.ftc.go.kr/www/selectBbsNttView.do?key=202&bordCd=201&nttSn=11139",
    },
  ],
};
