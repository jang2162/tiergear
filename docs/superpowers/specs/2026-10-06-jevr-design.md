# jevr 설계

날짜: 2026-10-06 (개정: 하네스 어댑터, `jevr spawn`, hook 런타임 확인 결과 반영)

## 목표

TypeSafe Jev가 에이전트 세션의 모델과 reasoning effort를 정한다. Orca 워커(코디네이터가
`orca` CLI로 띄우든, 사용자가 Orca 앱 UI에서 띄우든)와 사용자가 직접 쓰는 세션 모두에 적용된다.

### 성공 기준

- Claude Code 세션의 첫 프롬프트에서 Jev가 정한 모델과 effort가 적용된다.
- 이후 턴에는 Jev 판단에 따라 effort가 오르내리되, 짧은 후속 지시 때문에 잘못 낮아지지 않는다.
- 코디네이터는 `jevr spawn` 한 줄로 Jev가 정한 모델과 effort의 Claude 또는 Codex 워커를 Orca에 띄운다.
- spawn으로 띄운 워커는 spawn이 정한 tier 아래로 내려가지 않는다.
- Jev가 실패해도 사용자의 턴이 막히거나 시간 제한 이상 느려지지 않는다.

### 범위 밖 (v1)

- 프로젝트별 Jev 전송 차단. 사용자 결정으로 모든 곳에서 켠다.
- Codex 실행 중 조정(공식 훅이 없어 로컬 프록시가 필요하다. v2 후보).
- OpenCode 어댑터(`chat.params`로 effort만 조정 가능. v2 후보).
- subagent 모델 라우팅. 메인 세션만 다룬다.
- spawn이 만든 빈 fallback shell 자동 정리. 안 쓰는 shell인지 확실히 판단할 수 없어 남겨 두고 알린다.

## 기존 도구와의 차이

| 도구 | 한계 |
| --- | --- |
| jev-model-router (claude-code-templates mod) | 프롬프트 한 줄만 보고 분류해서 짧은 후속 지시가 쉬워 보인다. 바닥선이 없다. |
| gargpratyush/jev-router | 프록시 방식, 턴마다 모델만 바꾼다. effort를 다루지 않고 캐시가 깨진다. |
| handpickedlab/effort-router | command hook + MCP 방식이라 메인 세션의 모델을 바꿀 수 없다. |

## 하네스별 지원 범위

| 하네스 | 띄울 때 결정 | 실행 중 effort | 실행 중 모델 |
| --- | --- | --- | --- |
| Claude Code | `--model --effort` | function hook | function hook |
| Codex | `--model -c model_reasoning_effort=` | 불가(v1) | 불가(v1) |

## 구현 방식

core(판단 로직) + 하네스 어댑터. v1 어댑터는 Claude Code function hook과 CLI(`jevr`).

- function hook만이 Claude Code 메인 세션의 모델과 effort를 직접 바꿀 수 있다(`turn.step`).
- hook 모듈은 Node가 없는 별도 환경에서 돈다. 그래서 core는 Node API를 쓰지 않는 순수 TypeScript로
  짜고, 네트워크·파일·시계는 호출자가 주입한다. hook과 CLI가 같은 core를 쓴다.
- 위험: function hook은 early-access API라 Claude Code 버전이 올라가면 깨질 수 있다. 확인 기준 버전은 2.1.289.

## 구성 요소

### 1. core (`src/core/`)

- `tiers.ts`: tier 순서와 하네스별 표.

  Claude Code:

  | tier | model | effort |
  | --- | --- | --- |
  | trivial | haiku | low |
  | quick | sonnet | low |
  | standard | sonnet | high |
  | deep | opus | xhigh |
  | max | fable | max |

  Codex(기본값, 실제 모델 이름은 구현 첫 단계에서 확인):

  | tier | model | effort |
  | --- | --- | --- |
  | trivial | gpt-5.6-luna | low |
  | quick | gpt-5.6-terra | low |
  | standard | gpt-5.6-terra | high |
  | deep | gpt-5.6-sol | xhigh |
  | max | gpt-6-astra | xhigh |

  모델이 지원하지 않는 effort는 Claude Code 엔진이 조용히 낮춘다(`turn.step` 타입 문서). 그래서 별도 보정은 하지 않는다.

- `jev.ts`: Jev 요청 생성, 응답 검증, 시간 제한이 있는 호출. 전송(fetch)과 대기(sleep)는 주입한다.
- `state.ts`: Jev에 보낼 state를 만든다. 원래 작업 지시(세션 첫 프롬프트), 최근 6개 메시지(요약하지 않고
  길면 앞뒤만 남김), 이번 프롬프트, 수정한 파일 수, 같은 오류 반복 횟수, 현재 tier와 effort.
- `decide.ts`: 첫 턴과 이후 턴의 판단. 적용할 `{ model, effort }`를 돌려준다.
- `failures.ts`: 같은 오류 반복을 세는 추적기.
- `floor.ts`: 바닥선 기록의 형식, 유효성(24시간, 같은 worktree), 경로 해시.
- `config.ts`: 플러그인 옵션을 읽어 기본값과 합친다.

### 2. Claude Code hook (`hooks/jevr.ts`)

- `prompt.submit`: 맥락을 모아(`$.session.messages()`, `$.session.turns()`, `$.session.cwd()`,
  `$.session.id()`) core에 판단을 맡기고, 세션 기록을 `$.store`에 저장한다.
- `turn.step`: 메인 루프의 모든 요청(`agentId` 없음)에 세션 기록의 모델과 effort를 덮어쓴다.
  subagent 요청은 건드리지 않는다.
- `tool.call`: 도구 결과가 오류면 실패 추적기에 기록하고, 성공하면 초기화한다.
- 상태줄(`$.ui.status`): `jevr · deep 0.91 → opus/xhigh` 또는 `jevr · standard 0.62 · unchanged`.
- 키: 옵션 `typesafeApiKey`, 없으면 `$.env.get('TYPESAFE_API_KEY')`, 없으면 `$.settings.read()`의 `env`.

### 3. CLI (`jevr`, Node)

- `jevr launch "<작업 설명>" [--agent claude|codex] [--worktree <path>]`: Jev로 tier를 정하고 실행
  명령(`claude --model <m> --effort <e>` 또는 `codex --model <m> -c model_reasoning_effort="<e>"`)을
  출력한다. `--worktree`가 있으면 그 경로에 바닥선을 기록한다.
- `jevr spawn "<작업 설명>" --name <작업명> [--agent claude|codex] [--repo <dir>]`: Orca에 워커를 띄운다.
  1. Jev로 tier를 정한다.
  2. `orca worktree create --name <작업명> --no-parent --json` (`--repo` 디렉터리에서 실행).
  3. `orca terminal create --worktree id:<worktree.id> --title <작업명> --command '<실행 명령>' --json`.
  4. `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json`.
     `satisfied`가 `false`면 120000ms로 한 번 더 기다린다. 그래도 `false`면 "시작 실패"로 끝내고 보내지 않는다.
  5. `orca terminal send --terminal <handle> --text "<작업 설명>" --enter --json`.
  6. worktree 경로에 바닥선을 기록한다(Claude 워커만 의미가 있다).
  7. `terminal_handle_stale` 오류가 나면 `orca terminal list --worktree ... --json`으로 새 handle을 찾아 그 handle로만 이어 간다.
- `jevr stats [days]`: 결정 로그 요약(올림/내림/유지 수, Jev 응답률, 평균 지연).

### 4. 저장 위치

- 세션 기록: hook의 `$.store`, 키 `session:<session-id>`. 첫 tier, 현재 tier, 고정 모델, 바닥선, 하향 연속
  횟수, pin 여부, Jev 연속 실패 수, 쉬는 시각, 첫 프롬프트, 갱신 시각. 7일 지난 기록은 첫 턴에 지운다.
- 바닥선: `~/.local/state/jevr/floors/<worktree 경로 해시>.json`. CLI가 쓰고 hook이 `$.fs.read`로 읽는다.
  Orca가 띄운 프로세스에 환경변수가 전달된다는 보장이 없어서 파일로 넘긴다. 24시간이 지나거나 경로가
  다르면 무시한다. 바닥선은 `launch --worktree`나 `spawn`이 tier를 정해 띄웠다는 뜻이라, 유효한 바닥선이
있으면 hook이 첫 턴에 Jev를 다시 부르지 않는다.
- 결정 로그: `~/.local/state/jevr/decisions/<session-id 또는 cli-날짜>.jsonl`. 세션마다 파일을 따로 써서
  병렬 세션끼리 덮어쓰지 않는다. 프롬프트 원문은 남기지 않는다. 파일당 1000줄을 넘으면 앞쪽을 버린다.

## 판단 흐름

어느 턴이든 프롬프트가 `!pin`으로 시작하면 그 세션은 그때부터 자동 조정을 하지 않는다.

### 첫 턴

1. 이 worktree의 바닥선 파일을 읽는다.
2. 유효한 바닥선이 있으면(launch나 spawn으로 띄운 워커) Jev를 부르지 않고 그 tier를 현재 tier와 바닥선으로 쓴다.
3. 아니면 Jev가 첫 프롬프트로 tier를 정한다.
   - 확신도 0.5 이상: 그 tier를 쓴다. 바닥선이 있으면 그보다 낮아지지 않는다.
   - 확신도 0.5 미만 또는 실패: 현재 모델과 effort를 유지하고 tier는 미정으로 둔다.
4. 모델과 effort를 함께 적용한다. 첫 턴은 캐시가 없어서 모델 변경 비용이 없다.
5. 바닥선 파일이 없으면 첫 tier보다 한 단계 아래를 바닥선으로 둔다.

### 이후 턴

Jev에 두 가지를 묻는다. "다음 단계에 맞는 tier는?"(choice, tier별 확률) "이 세션이 막혀 있나?"(noul)

| 상황 | 동작 |
| --- | --- |
| tier 미정이고 Jev 확신도 0.5 이상 | 그 tier로 정하고 바닥선은 한 단계 아래 |
| Jev tier가 더 높고 확신도 0.5 이상 | 즉시 그 tier로 올린다(여러 단계 가능) |
| 막힘 신호: 같은 오류 3번, 또는 Jev stuck 0.6 이상 | 한 단계 올린다 |
| Jev tier가 더 낮고 확신도 0.85 이상, 2턴 연속 | 한 단계만 내린다. 바닥선 아래로는 안 간다 |
| 그 외 | 유지 |

### 모델 변경 정책

옵션 `switchModelMidSession`, 기본값 `false`.

- `false`: 첫 턴 이후에는 모델을 고정하고 tier의 effort만 적용한다. 예: sonnet 세션에서 deep →
  `sonnet/xhigh`, opus 세션에서 trivial → `opus/low`.
- `true`: tier 표대로 모델까지 바꾼다. 모델이 바뀌면 프롬프트 캐시가 깨진다.

## 오류 처리

- Jev 시간 초과, 오류, 키 없음, 형식 이상: 이번 턴은 현 상태를 유지하고 이유를 로그에 남긴다.
- 시간 제한: 첫 턴 2000ms, 이후 턴 1200ms, CLI 5000ms. 옵션으로 바꿀 수 있다.
- Jev 연속 3회 실패: 5분 동안 Jev 호출을 쉰다.
- CLI에서 Jev 실패: `standard`로 정하고 경고를 출력한다.
- 세션 기록이 깨졌으면 새로 시작한다.

## 설정 (Claude Code 플러그인 옵션)

| 옵션 | 기본값 |
| --- | --- |
| `typesafeApiKey` | 없으면 `TYPESAFE_API_KEY` |
| `switchModelMidSession` | `false` |
| `minUpgradeConfidence` | `0.5` |
| `minDowngradeConfidence` | `0.85` |
| `downgradeStreak` | `2` |
| `stuckConfidence` | `0.6` |
| `stuckFailures` | `3` |
| `firstTurnTimeoutMs` | `2000` |
| `turnTimeoutMs` | `1200` |
| `jevModel` | `jev-latest` |

## 테스트

- core 단위 테스트(가짜 Jev, 네트워크 없음): 비대칭 조건, 2턴 연속, 바닥선, pin, 모델 고정 시 effort만
  변경, 시간 초과 시 유지, 연속 실패 휴지, 막힘 신호, spawn 바닥선이면 Jev 생략.
- hook 테스트: 가짜 `$`로 `prompt.submit` → `turn.step` 흐름을 돌려 덮어쓰기 값을 확인.
- CLI 테스트: 가짜 orca 실행기로 spawn 순서, 대기 실패 시 미전송, stale handle 복구를 확인.
- 실제 확인: 실제 Jev에 대표 프롬프트를 보내 tier와 지연 시간을 확인하는 데모 스크립트.

## 구현 전 확인할 것

1. 세션 중 effort만 바꿔도 프롬프트 캐시가 깨지는지(설계는 그대로, 문서에 비용으로 적는다).
2. `$.store`가 세션을 넘어 유지되는 플러그인 단위 저장소인지.
3. Jev choice 질문의 실제 응답 형태와 지연 시간.
4. Orca CLI `--json` 결과의 실제 필드(`worktree.id`, `worktree.path`, 터미널 handle, `wait.satisfied`).
5. Codex에서 쓸 수 있는 모델 이름과 effort 값.
6. 최신 hook 타입(`/plugin-types`로 2.1.289 기준 재생성).
