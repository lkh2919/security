# 30분 안에 도입하기

신규 계열사·부서는 코드 변경 없이 데이터만으로 도입합니다. 설정 파일 1개, 공개 방침 폴더, 선택 사항인 동종사 목록이면 충분합니다. 영문판: [`../adopt-in-30-minutes.md`](../adopt-in-30-minutes.md).

모든 출력은 참고용 검토 결과입니다("참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."). 법률 자문이 아닙니다.

## 0. 사전 준비 (5분)

- Bun 설치 후 `bun install`.
- 모델 백엔드(선택):
  - Claude Code 로그인: `--llm claude-code` (API 키 불필요)
  - 또는 `.env`의 `ANTHROPIC_API_KEY`와 `--llm api`
  - 또는 `--llm none`: 결정적 점검만 수행(보고서에 명시됨)
- 선택: `LAW_GO_KR_OC`(law.go.kr 키, 등록 IP 한정). `daily`의 법령 최신성 단계와 `peer-history`에 필요하며, 없으면 `daily`는 해당 단계를 건너뜁니다.

## 1. 조직 설정 만들기 (5분)

`config/orgs/example/org.json`을 `config/orgs/<org>/org.json`으로 복사해 수정합니다.

| 필드 | 의미 |
|------|------|
| `tenantId` | `[a-z0-9-]` 1~32자, 모든 출력 경로의 접두어 |
| `domainGroup` | 동종사 그룹 (`peers`의 기본 그룹) |
| `policyDir` | 방침 폴더(절대경로가 아니면 저장소 루트 기준) |
| `reviewers` | 역할명만. 이름·연락처 금지 |
| `apps` | 사용할 명령: `check`, `impact`, `peers`, `draft`. `daily`는 `check` 또는 `impact` 필요 |
| `llm` | 기본 백엔드 `api`, `claude-code`, `none` (`--llm`으로 덮어씀) |
| `rulePacks` | `kb/jurisdictions/kr/rulepacks/` 아래 규칙 팩 ID. 첫 번째가 결정적 점검 기준 |
| `peersFile` | 선택. 동종사 레지스트리(설정 폴더 기준 상대경로) |

비밀 값과 개인정보는 넣지 마십시오.

## 2. 방침 파일 넣기 (5분)

`policyDir`에 `.md`, `.html`, `.htm` 파일을 넣습니다. `.docx`, `.pdf`는 아직 읽지 못하고 "수동 검토 필요"로 보고됩니다. `watch/`는 git에서 제외됩니다.

## 3. 동종사 목록 (선택, 2분)

`peersFile`에 그룹용 레지스트리 JSON을 지정합니다(공용: `kb/jurisdictions/kr/monitor/peers/peer-registry.json`). 동종사는 참고용입니다.

## 4. 실행 (10분)

```bash
bun scripts/agent.ts check  --config config/orgs/<org>/org.json --llm claude-code [--force]
bun scripts/agent.ts impact --config config/orgs/<org>/org.json --diff old.xml,new.xml --law PIPA [--effective YYYY-MM-DD] --llm claude-code
bun scripts/agent.ts daily  --config config/orgs/<org>/org.json --llm claude-code [--run-id daily-YYYYMMDD] [--skip-peers]
bun scripts/agent.ts peers  --config config/orgs/<org>/org.json [--group <id>] [--dry-run] [--limit N] [--with-lotte]
bun scripts/peer-history.ts --config config/orgs/<org>/org.json [--group <id>] [--law PIPA --old-mst <mst> --new-mst <mst>]
bun scripts/agent.ts draft  --config config/orgs/<org>/org.json --transcript interview.txt --form form.md [--masking basic] --llm claude-code
```

동종사 수집은 robots.txt를 따르며 호스트당 UTC 하루 1페이지만 가져옵니다.

## 5. 출력 위치

모두 `runs/<tenantId>/` 아래(git 제외)에 저장됩니다. 실행 결과를 커밋하지 마십시오.

- `check`, `impact`: `runs/<tenantId>/monitor/<stamp>/`
- `daily`: `runs/<tenantId>/daily/<runId>/`
- `peers`, `peer-history`: `runs/<tenantId>/peers/`
- `draft`: `runs/<tenantId>/draft/<runId>/`

## 6. 보고서 읽는 법

- **심각도**: `critical`, `high`, `medium`, `low`, `confirm` 순.
- **잠정(provisional) vs 확정(confirmed)**: 확정은 검토된 규칙 팩 기준입니다. 잠정은 개정 영향의 자동 추정으로 미검증이며 Medium을 넘지 않습니다.
- **Confirm 질문**: 공개 문구만으로 의무를 입증할 수 없을 때 위반 단정 대신 질문을 제시합니다. 서비스 담당자와 확인하십시오.
- **금융**: 금융 어휘가 있는 문단은 "금융 법령 해당 – 수동 검토"로 표시되며 모델에 보내지 않고 문구 제안도 없습니다. 금융은 모니터링 전용입니다.
- **동종사 신호**는 업계 참고 자료이며 법적 요구사항이 아닙니다. 동종사 평가·순위는 하지 않습니다.

## 7. 한계

- 참고용이며 법률 자문이 아닙니다. 변경 전 정보보호실·법무 검토가 필요합니다.
- DOCX·PDF 입력은 아직 지원하지 않습니다.
- 금융 방침은 모니터링과 수동 검토만 합니다.
- 법령 최신성과 `peer-history`는 등록 IP의 `LAW_GO_KR_OC`가 필요합니다.
