# tiergear 설계

날짜: 2026-10-06 (개정 3: 이름 변경 jevr → tiergear, 판단기(Judge) 추상화, 표 A·B 구조, 모델별 effort 확인 결과 반영)

## 목표

판단 모델(Jev, Laya, Kev 중 선택)이 에이전트 세션의 모델과 reasoning effort를 정한다. Orca 워커(코디네이터가
`orca` CLI로 띄우든, 사용자가 Orca 앱 UI에서 띄우든)와 사용자가 직접 쓰는 세션 모두에 적용된다.

### 성공 기준

- Claude Code 세션의 첫 프롬프트에서 판단기가 정한 모델과 effort가 적용된다.
- 이후 턴에는 판단에 따라 effort가 오르내리되, 짧은 후속 지시 때문에 잘못 낮아지지 않는다.
- 코디네이터는 `tiergear spawn` 한 줄로 판단기가 정한 모델과 effort의 Claude 또는 Codex 워커를 Orca에 띄운다.
- spawn으로 띄운 워커는 spawn이 정한 tier 아래로 내려가지 않는다.
- 판단기가 실패해도 사용자의 턴이 막히거나 시간 제한 이상 느려지지 않는다.
- 다른 판단 모델을 추가할 때 core와 hook을 고치지 않고 판단기 구현 하나만 더한다.

### 범위 밖 (v1)

- 프로젝트별 판단기 전송 차단. 사용자 결정으로 모든 곳에서 켠다.
- systemone 형식이 아닌 판단기(구조만 열어 둔다).
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

core(판단 로직) + 판단기(Judge) + 하네스 어댑터. v1 판단기는 systemone 형식(Jev, Laya, Kev 프리셋), v1 어댑터는 Claude Code function hook과 CLI(`tiergear`).

- function hook만이 Claude Code 메인 세션의 모델과 effort를 직접 바꿀 수 있다(`turn.step`).
- hook 모듈은 Node가 없는 별도 환경에서 돈다. 그래서 core는 Node API를 쓰지 않는 순수 TypeScript로
  짜고, 네트워크·파일·시계는 호출자가 주입한다. hook과 CLI가 같은 core를 쓴다.
- 위험: function hook은 early-access API라 Claude Code 버전이 올라가면 깨질 수 있다. 확인 기준 버전은 2.1.289.

## 티어표

판단기는 tier 5개(trivial, quick, standard, deep, max) 중 하나를 고른다. tier를 늘리지 않는 이유: 판단 모델은
기준이 뚜렷이 구분될 때 정확하고, 칸을 잘게 나누면 경계에서 흔들린다. 세밀한 조정은 표 B가 맡는다.

### 표 A: tier → 모델

| tier | Claude Code | Codex (구현 첫 단계에서 실제 이름 확인) |
| --- | --- | --- |
| trivial | haiku | gpt-5.6-luna |
| quick | sonnet | gpt-5.6-terra |
| standard | sonnet | gpt-5.6-terra |
| deep | opus | gpt-5.6-sol |
| max | fable | gpt-6-astra |

### 표 B: 모델별 tier → effort

모델이 강할수록 같은 난이도에 effort를 낮게 잡는다. `-`는 effort를 보내지 않는다는 뜻이다.

Claude Code:

| tier | haiku | sonnet | opus | fable |
| --- | --- | --- | --- | --- |
| trivial | - | low | low | low |
| quick | - | low | low | low |
| standard | - | medium | medium | medium |
| deep | - | high | xhigh | high |
| max | - | max | max | xhigh |

Codex(값은 구현 첫 단계에서 허용 값 확인 후 확정):

| tier | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-sol | gpt-6-astra |
| --- | --- | --- | --- | --- |
| trivial | low | low | low | low |
| quick | low | low | low | low |
| standard | medium | medium | medium | medium |
| deep | high | high | high | high |
| max | high | xhigh | xhigh | xhigh |

### 적용 규칙

- 첫 턴(모델도 정함): 모델 = `A[tier]`, effort = `B[A[tier]][tier]`.
  - Claude Code 첫 턴 결과: trivial `haiku/-`, quick `sonnet/low`, standard `sonnet/medium`, deep `opus/xhigh`, max `fable/xhigh`.
- 이후 턴, 모델 고정(기본): effort = `B[세션 모델][tier]`.
- 세션 모델이 표 B에 없으면(전체 id, 모르는 모델) alias로 바꿔 찾고, 그래도 없으면 `B[A[tier]][tier]`를 쓴다.
- 두 표는 `~/.config/tiergear/tables.json`으로 일부 칸만 덮어쓸 수 있다. hook과 CLI가 같은 파일을 읽는다.
  파일이 깨졌거나 표에 없는 tier·effort 값이 있으면 그 파일 전체를 무시하고 기본표를 쓴다.

### 모델별 effort 사실 (Anthropic 공식 자료, 2026-09-25 기준)

| 모델 | 지원 | 기본값 |
| --- | --- | --- |
| Haiku 4.5 | effort 없음(보내면 API 오류, Claude Code는 생략) | - |
| Sonnet 5.5 | low~max | high (재조정됨, 에이전트 코딩은 medium부터 권장) |
| Opus 5.5 | low~max | medium |
| Fable 5.1 | low~max | high |

세션 중에 최상위 effort를 바꾸면 messages 캐시가 무효화된다(공식 문서). 그래서 effort만 바꾸는 기본 정책에도
비용이 있다. 하향 조건(확신도 0.85, 2턴 연속, 한 단계씩)이 이 비용도 줄인다. 캐시를 깨지 않는 per-message
effort(beta)는 Claude Code hook에서 쓸 수 있는지 확인되지 않아 v1에서는 쓰지 않는다.

## 판단기

Jev, Laya, Kev는 모두 TypeSafe의 `POST /v1/systemone` 계약(noul, choice, score 질문)을 그대로 따른다. 그래서
판단기 구현은 하나(systemone)이고, 프리셋이 주소와 모델과 키를 정한다.

| 프리셋 | 기본 주소 | 모델 | 키 | 비고 |
| --- | --- | --- | --- | --- |
| `jev` | `https://api.typesafe.ai` | `jev-latest` | `TYPESAFE_API_KEY` (필수) | TypeSafe 호스팅. 대화 내용이 외부로 나간다 |
| `laya` | `http://localhost:11435` | `laya` | `OLLAYA_API_KEY` (선택) | Ollaya로 로컬 실행(`ollaya run laya`). Apache-2.0. Mac CPU에서 0.3~2.4초 |
| `kev` | `http://localhost:8009` | `kev-latest` | `KEV_API_KEY` (선택, Modal 배포 시) | 로컬 실행(`python -m kev.serve --run jaredpalmer/kev-4b --port 8009`). Apache-2.0. Apple Silicon M5에서 Kev-4B 새 텍스트 약 0.7초 |

- 프리셋별 기본 시간 제한(첫 턴/이후 턴): jev 2000/1200ms, laya 3000/2500ms, kev 3000/2000ms. 로컬 모델은 장비에
  따라 지연이 크게 달라서 넉넉하게 잡고, 실제 지연은 구현 중 측정해 조정한다.
- 옵션으로 주소(`judgeBaseUrl`), 모델(`judgeModel`), 키(`judgeApiKey`)를 덮어쓸 수 있다. 예: Kev를 Modal에 올렸으면
  `judgeBaseUrl`만 바꾼다.
- laya와 kev는 로컬 실행이라 대화 내용이 장비 밖으로 나가지 않는다.
- 위험: 확신도 기준값(0.5, 0.85, 0.6)은 Jev를 기준으로 정했다. 다른 모델은 확신도 분포가 다를 수 있어 `tiergear stats`로
  보고 조정한다.
- 로컬 서버가 꺼져 있으면 연결 오류가 곧바로 나서 지연 없이 현 상태를 유지한다. 3번 연속 실패하면 5분 쉰다.

## 구성 요소

### 1. core (`src/core/`)

- `tiers.ts`: tier 순서, effort 값, 모델 alias↔id, 실행 명령 생성.
- `tables.ts`: 기본 표 A·B, 덮어쓰기 병합과 검증, `firstTarget`(첫 턴 모델+effort), `effortFor`(모델 고정 시 effort).
- `judge.ts`: 판단기 계약. `Judge.ask({ state, withStuck, timeoutMs }) → { ok, verdict: { tier, confidence, stuck } }`.
  시간 제한과 오류를 결과값으로 바꾸는 공통 처리.
- `judges/systemone.ts`: TypeSafe `/v1/systemone` 형식의 판단기. 요청 생성, 응답 검증. 전송(fetch)과 대기(sleep)는 주입한다.
  Jev, Laya, Kev가 모두 이 형식을 그대로 쓰므로 하나로 셋을 지원한다.
- `judges/presets.ts`: 판단기 프리셋(주소, 모델, 키 환경변수, 기본 시간 제한).
- `state.ts`: 판단기에 보낼 state. 원래 작업 지시(세션 첫 프롬프트), 최근 6개 메시지(요약하지 않고 길면 앞뒤만),
  이번 프롬프트, 수정한 파일 수, 같은 오류 반복 횟수, 현재 tier와 effort.
- `decide.ts`: 첫 턴과 이후 턴의 판단. 적용할 `{ model?, effort }`를 돌려준다.
- `failures.ts`: 같은 오류 반복을 세는 추적기.
- `floor.ts`: 바닥선 기록의 형식, 유효성(24시간, 같은 worktree), 경로 해시.
- `config.ts`: 플러그인 옵션을 읽어 기본값과 합친다.
- `log.ts`: 결정 로그 형식과 줄 수 제한.

### 2. Claude Code hook (`hooks/tiergear.ts`)

- `prompt.submit`: 맥락을 모아(`$.session.messages()`, `$.session.cwd()`, `$.session.id()`) core에 판단을 맡기고,
  세션 기록을 `$.store`에 저장한다.
- `turn.step`: 메인 루프의 모든 요청(`agentId` 없음)에 세션 기록의 모델과 effort를 덮어쓴다. effort가 `-`면
  effort를 보내지 않는다. subagent 요청은 건드리지 않는다.
- `tool.call`: 도구 결과가 오류면 실패 추적기에 기록하고, 같은 도구가 성공하면 초기화한다.
- 상태줄(`$.ui.status`): `tiergear · deep 0.91 → opus/xhigh` 또는 `tiergear · standard 0.62 · unchanged (same tier)`.
- 판단기 키: 옵션 `judgeApiKey`, 없으면 `$.env.get(<프리셋 키 환경변수>)`, 없으면 `$.settings.read()`의 `env`.

### 3. CLI (`tiergear`, Node)

- `tiergear launch "<작업 설명>" [--agent claude|codex] [--worktree <path>]`: 판단기로 tier를 정하고 실행 명령
  (`claude --model <m> [--effort <e>]` 또는 `codex --model <m> [-c model_reasoning_effort="<e>"]`)을 출력한다.
  `--worktree`가 있으면 그 경로에 바닥선을 기록한다.
- `tiergear spawn "<작업 설명>" --name <작업명> [--agent claude|codex] [--repo <dir>]`: Orca에 워커를 띄운다.
  1. 판단기로 tier를 정한다.
  2. `orca worktree create --name <작업명> --no-parent --json` (`--repo` 디렉터리에서 실행).
  3. Claude 워커면 worktree 경로에 바닥선을 기록한다(에이전트가 첫 프롬프트를 읽기 전에).
  4. `orca terminal create --worktree id:<worktree.id> --title <작업명> --command '<실행 명령>' --json`.
  5. `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json`.
     `satisfied`가 `false`면 120000ms로 한 번 더 기다린다. 그래도 `false`면 "시작 실패"로 끝내고 보내지 않는다.
  6. `orca terminal send --terminal <handle> --text "<작업 설명>" --enter --json`.
  7. `terminal_handle_stale` 오류가 나면 `orca terminal list --worktree ... --json`으로 새 handle을 찾아 그 handle로만 이어 간다.
- `tiergear stats [days]`: 결정 로그 요약(set/up/down/hold 수, 판단기 응답률, 평균 지연).

### 4. 저장 위치

- 세션 기록: hook의 `$.store`, 키 `session:<session-id>`. 첫 tier, 현재 tier, 고정 모델, 적용값, 바닥선, 하향 연속
  횟수, pin 여부, 판단기 연속 실패 수, 쉬는 시각, 첫 프롬프트, 갱신 시각. 7일 지난 기록은 첫 턴에 지운다.
- 표 덮어쓰기: `~/.config/tiergear/tables.json`.
- 바닥선: `~/.local/state/tiergear/floors/<worktree 경로 해시>.json`. CLI가 쓰고 hook이 `$.fs.read`로 읽는다.
  Orca가 띄운 프로세스에 환경변수가 전달된다는 보장이 없어서 파일로 넘긴다. 24시간이 지나거나 경로가 다르면
  무시한다. 바닥선은 `launch --worktree`나 `spawn`이 tier를 정해 띄웠다는 뜻이라, 유효한 바닥선이 있으면 hook이
  첫 턴에 판단기를 다시 부르지 않는다.
- 결정 로그: `~/.local/state/tiergear/decisions/<session-id 또는 cli-날짜>.jsonl`. 세션마다 파일을 따로 써서
  병렬 세션끼리 덮어쓰지 않는다. 프롬프트 원문은 남기지 않는다. 파일당 1000줄을 넘으면 앞쪽을 버린다.

## 판단 흐름

어느 턴이든 프롬프트가 `!pin`으로 시작하면 그 세션은 그때부터 자동 조정을 하지 않는다. `!pin`은 지우고 나머지를
보내며, 지운 뒤 비면 원래 텍스트를 보낸다. `/`로 시작하는 명령은 건드리지 않는다.

### 첫 턴

1. 이 worktree의 바닥선 파일을 읽는다.
2. 유효한 바닥선이 있으면(launch나 spawn으로 띄운 워커) 판단기를 부르지 않고 그 tier를 현재 tier와 바닥선으로 쓴다.
3. 아니면 판단기가 첫 프롬프트로 tier를 정한다.
   - 확신도 0.5 이상: 그 tier를 쓴다.
   - 확신도 0.5 미만 또는 실패: 현재 모델과 effort를 유지하고 tier는 미정으로 둔다.
4. 모델과 effort를 함께 적용한다(`firstTarget`). 첫 턴은 캐시가 없어서 모델 변경 비용이 없다.
5. 바닥선 파일이 없으면 첫 tier보다 한 단계 아래를 바닥선으로 둔다.

### 이후 턴

판단기에 두 가지를 묻는다. "다음 단계에 맞는 tier는?"(tier별 확률) "이 세션이 막혀 있나?"(확률)

| 상황 | 동작 |
| --- | --- |
| tier 미정이고 확신도 0.5 이상 | 그 tier로 정하고 바닥선은 한 단계 아래 |
| 판단 tier가 더 높고 확신도 0.5 이상 | 즉시 그 tier로 올린다(여러 단계 가능) |
| 막힘 신호: 같은 오류 3번, 또는 stuck 0.6 이상 | 한 단계 올린다 |
| 판단 tier가 더 낮고 확신도 0.85 이상, 2턴 연속 | 한 단계만 내린다. 바닥선 아래로는 안 간다 |
| 그 외 | 유지 |

### 모델 변경 정책

옵션 `switchModelMidSession`, 기본값 `false`.

- `false`: 첫 턴 이후에는 모델을 고정하고 effort = `B[세션 모델][tier]`. 예: sonnet 세션에서 deep → `sonnet/high`,
  opus 세션에서 trivial → `opus/low`.
- `true`: 첫 턴처럼 `firstTarget(tier)`로 모델까지 바꾼다. 모델이 바뀌면 프롬프트 캐시가 깨진다.

## 오류 처리

- 판단기 시간 초과, 오류, 키 없음, 형식 이상: 이번 턴은 현 상태를 유지하고 이유를 로그에 남긴다.
- 시간 제한: 첫 턴 2000ms, 이후 턴 1200ms, CLI 5000ms. 옵션으로 바꿀 수 있다.
- 판단기 연속 3회 실패: 5분 동안 호출을 쉰다.
- CLI에서 판단기 실패 또는 확신도 0.5 미만: `standard`로 정하고 경고를 출력한다.
- 세션 기록이나 표 파일이 깨졌으면 무시하고 새로/기본값으로 시작한다.

## 설정 (Claude Code 플러그인 옵션)

| 옵션 | 기본값 |
| --- | --- |
| `judge` | `jev` (`jev`, `laya`, `kev`) |
| `judgeBaseUrl` | 프리셋 주소 |
| `judgeModel` | 프리셋 모델 |
| `judgeApiKey` | 없으면 프리셋의 키 환경변수 |
| `switchModelMidSession` | `false` |
| `minUpgradeConfidence` | `0.5` |
| `minDowngradeConfidence` | `0.85` |
| `downgradeStreak` | `2` |
| `stuckConfidence` | `0.6` |
| `stuckFailures` | `3` |
| `firstTurnTimeoutMs` | 프리셋 값 |
| `turnTimeoutMs` | 프리셋 값 |

CLI는 플러그인 옵션을 읽지 못하므로 `--judge`, `--judge-url`, `--judge-model` 플래그와 같은 환경변수를 쓴다.
CLI 시간 제한은 판단기와 상관없이 5000ms.

## 테스트

- core 단위 테스트(가짜 판단기, 네트워크 없음): 표 A·B 적용과 덮어쓰기, 비대칭 조건, 2턴 연속, 바닥선, pin,
  모델 고정 시 effort만 변경, Haiku의 effort 생략, 시간 초과 시 유지, 연속 실패 휴지, 막힘 신호, 바닥선이면 판단기 생략.
- hook 테스트: 가짜 `$`로 `prompt.submit` → `turn.step` 흐름을 돌려 덮어쓰기 값을 확인.
- CLI 테스트: 가짜 orca 실행기로 spawn 순서, 대기 실패 시 미전송, stale handle 복구를 확인.
- 실제 확인: 실제 Jev에 대표 프롬프트를 보내 tier와 지연 시간을 확인하는 데모 스크립트.

## 구현 전 확인할 것

1. `$.store`가 세션을 넘어 유지되는 플러그인 단위 저장소인지.
2. Jev, Laya, Kev 각각 choice 질문의 실제 응답 형태와 지연 시간(Laya와 Kev는 로컬에 띄워서 측정).
3. Orca CLI `--json` 결과의 실제 필드(`worktree.id`, 터미널 handle, `wait.satisfied`, 오류 code).
4. Codex에서 쓸 수 있는 모델 이름과 `model_reasoning_effort` 허용 값.
5. 최신 hook 타입(`/plugin-types`로 2.1.289 기준 재생성): `turn.step`의 `model`이 alias를 받는지, effort를
   빼면 엔진이 기존 값을 유지하는지(Haiku는 어차피 엔진이 effort를 생략한다).
