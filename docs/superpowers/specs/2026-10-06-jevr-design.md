# jevr 설계

날짜: 2026-10-06

## 목표

TypeSafe Jev가 Claude Code 세션의 모델과 reasoning effort를 정한다. Orca 워커(코디네이터가
`orca` CLI로 띄우든, 사용자가 Orca 앱 UI에서 띄우든)와 사용자가 직접 쓰는 세션 모두에 같은
방식으로 적용된다.

### 성공 기준

- 세션의 첫 프롬프트에서 Jev가 정한 모델과 effort가 적용된다.
- 이후 턴에는 Jev 판단에 따라 effort가 오르내리되, 짧은 후속 지시 때문에 잘못 낮아지지 않는다.
- 코디네이터가 띄운 워커는 코디네이터가 정한 값 아래로 내려가지 않는다.
- Jev가 실패해도 사용자의 턴이 막히거나 느려지지 않는다(시간 제한 안에서 현 상태 유지).

### 범위 밖

- 프로젝트별 Jev 전송 차단. 사용자 결정으로 모든 곳에서 켠다.
- Claude 외 에이전트(Codex 등) 라우팅.
- subagent 모델 라우팅. 메인 세션만 다룬다.

## 기존 도구와의 차이

| 도구 | 한계 |
| --- | --- |
| jev-model-router (claude-code-templates mod) | 프롬프트 한 줄만 보고 분류해서 짧은 후속 지시가 쉬워 보인다. 바닥선이 없다. |
| gargpratyush/jev-router | 프록시 방식, 턴마다 모델만 바꾼다. effort를 다루지 않고 캐시가 깨진다. |
| handpickedlab/effort-router | command hook + MCP 방식이라 메인 세션의 모델을 바꿀 수 없다. |

## 구현 방식

Claude Code function hook mod + CLI. 판단 로직(core)은 둘이 공유한다.

- function hook만이 메인 세션의 모델과 effort를 직접 바꿀 수 있다(`turn.step`).
- 위험: function hook은 early-access API라 Claude Code 버전이 올라가면 깨질 수 있다. 확인 기준 버전은 2.1.289.

## 구성 요소

### 1. core (`src/core/`)

네트워크 없이 테스트할 수 있는 순수 함수.

- `TIERS`: tier별 모델과 effort 표.

  | tier | model | effort |
  | --- | --- | --- |
  | trivial | haiku | low |
  | quick | sonnet | low |
  | standard | sonnet | high |
  | deep | opus | xhigh |
  | max | fable | max |

- `buildState(context)`: Jev에 보낼 state를 만든다. 원래 작업 지시(세션 첫 프롬프트), 최근 6개
  메시지(요약하지 않고 길면 앞뒤만 남김), 수정한 파일 수, 실패 횟수, 현재 tier.
- `askJev(state, questions, options)`: TypeSafe System One 호출. 시간 제한, 응답 검증 포함.
  `JevAsker` 인터페이스로 감싸 테스트에서 가짜로 바꾼다.
- `decide(answers, session, config)`: 올림, 내림, 유지를 정하고 적용할 `{ model?, effort? }`를 돌려준다.
- `fitEffort(model, effort)`: 모델이 지원하지 않는 effort를 가장 가까운 지원 단계로 맞춘다.

### 2. hook mod (`hooks/jevr.ts`)

- `prompt.submit`: 맥락을 모아(`$.session.messages()`, `$.session.turns()`, `$.session.model()`,
  `$.session.cwd()`, `$.session.id()`) core에 판단을 맡기고 결과를 대기열에 둔다.
- `turn.step`: 그 턴의 첫 요청에 결정된 모델과 effort를 적용한다.
- 상태줄: `jevr · deep 0.91 → opus/xhigh` 또는 `jevr · standard 0.62 · unchanged`.
- 실패 감지: 같은 오류가 반복되는 도구 실패를 세어 다음 판단의 막힘 신호로 쓴다.

### 3. CLI (`bin/jevr`)

- `jevr launch "<작업 설명>" [--worktree <path>]`: Jev로 tier를 정하고
  `claude --model <m> --effort <e>` 명령을 출력한다. 대상 worktree의 바닥선 파일을 기록한다.
  코디네이터는 출력을 `orca terminal create --command`에 그대로 쓴다.
- `jevr stats [days]`: 결정 로그 요약.

### 4. 상태 저장소 (`~/.local/state/jevr/`)

- `sessions/<session-id>.json`: 첫 tier, 현재 tier, 바닥선, 하향 연속 횟수, pin 여부, Jev 연속 실패 수.
- `floors/<worktree 경로 해시>.json`: CLI가 쓰고 hook이 읽는 바닥선. Orca가 띄운 프로세스에
  환경변수가 전달된다는 보장이 없어서 파일로 넘긴다. 24시간이 지나면 무시한다.
- `decisions.jsonl`: 결정 로그. 프롬프트 원문은 남기지 않는다. 5MB에서 교체한다.

## 판단 흐름

어느 턴이든 프롬프트가 `!pin`으로 시작하면 그 세션은 그때부터 자동 조정을 하지 않는다.

### 첫 턴

1. 이 worktree의 바닥선 파일을 읽는다.
2. Jev가 첫 프롬프트로 tier를 정한다.
   - 확신도 0.5 이상: 그 tier를 쓴다. 바닥선이 있으면 그보다 낮아지지 않는다.
   - 확신도 0.5 미만 또는 실패: 현재 모델과 effort를 유지한다.
3. 모델과 effort를 함께 적용한다. 첫 턴은 캐시가 없어서 모델 변경 비용이 없다.
4. 첫 tier를 기록한다. 바닥선 파일이 없으면 첫 tier보다 한 단계 아래를 바닥선으로 둔다.

### 이후 턴

Jev에 두 가지를 묻는다. "다음 단계에 맞는 tier는?"(tier별 확률) "이 세션이 막혀 있나?"

| 상황 | 동작 |
| --- | --- |
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
- 시간 제한: 첫 턴 2000ms, 이후 턴 1200ms. 옵션으로 바꿀 수 있다.
- Jev 연속 3회 실패: 5분 동안 Jev 호출을 쉰다.
- 상태 파일 손상: 새로 시작한다.

## 설정

| 옵션 | 기본값 |
| --- | --- |
| `typesafeApiKey` | 없으면 `TYPESAFE_API_KEY` 환경변수 |
| `switchModelMidSession` | `false` |
| `minUpgradeConfidence` | `0.5` |
| `minDowngradeConfidence` | `0.85` |
| `downgradeStreak` | `2` |
| `stuckConfidence` | `0.6` |
| `firstTurnTimeoutMs` | `2000` |
| `turnTimeoutMs` | `1200` |
| `tiers` | 위 표 |

## 테스트

- core 단위 테스트(가짜 Jev, 네트워크 없음): 비대칭 조건, 2턴 연속, 바닥선, pin,
  모델 고정 시 effort만 변경, 지원하지 않는 effort 맞춤, 시간 초과 시 유지, 연속 실패 휴지.
- hook 테스트: `claude plugin test`로 첫 턴과 이후 턴 동작 확인.
- 실제 확인: 실제 Jev에 대표 프롬프트를 보내 tier와 지연 시간을 확인하는 데모 스크립트.

## 구현 전 확인할 것

1. 모델별 지원 effort 단계(Sonnet의 `xhigh`/`max`, Haiku 4.5의 effort 지원 여부).
2. 세션 중 effort만 바꿔도 프롬프트 캐시가 깨지는지.
3. hook에서 현재 세션의 effort를 읽을 수 있는지. 없으면 상태 파일의 값으로 추적한다.
4. hook의 `options`로 sensitive 옵션과 환경변수를 어떻게 읽는지.
5. Jev 요청 형식: tier별 확률 질문과 stuck 질문을 한 요청에 담는 방법.
