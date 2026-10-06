# tiergear

판단 모델(judge)이 Claude Code 세션과 Orca 워커의 모델과 reasoning effort를 정해 주는 플러그인이자 CLI입니다.

- **첫 턴**: 첫 프롬프트를 판단기에 보내 tier(trivial, quick, standard, deep, max)를 받고, 표 A·B로 모델과 effort를 정합니다. 첫 턴에는 잃을 캐시가 없어 모델도 함께 바뀝니다.
- **이후 턴**: 기본은 모델을 그대로 두고 effort만 조정합니다. 올리는 것은 쉽고(확신도 0.5), 내리는 것은 어렵습니다(확신도 0.85가 연속 2턴).
- **바닥선**: 첫 판단의 한 단계 아래 밑으로는 내려가지 않습니다. `tiergear launch`/`spawn`으로 띄운 세션은 띄울 때의 tier가 바닥선입니다.
- **`!pin`**: 프롬프트를 `!pin`으로 시작하면 그 세션은 고정됩니다. tiergear가 적용하던 모델과 effort를 거두고, 그때부터는 세션 자체의 모델과 effort(시작 플래그나 `/model`, `/effort`로 정한 값)가 그대로 쓰입니다(`!pin` 접두어는 판단기와 모델에 가기 전에 제거됩니다).
- **직접 바꾸면 멈춤**: 세션 중에 `/model`이나 `/effort`로 모델이나 effort를 직접 바꾸면 `!pin`과 똑같이 그 세션의 조정을 멈추고 hook 로그에 `[tiergear] manual model/effort change — routing paused for this session`을 한 번 남깁니다. 엔진이 보고하는 세션 값을 턴 사이에 비교하므로 tiergear 자신의 변경은 여기에 걸리지 않습니다. 엔진이 턴 첫 요청부터 대체 모델(fallback)로 바꾼 경우에도 수동 변경으로 보일 수 있습니다.

판단기가 느리거나 실패하면 해당 턴은 건드리지 않고 그대로 진행합니다.

### 판단하는 프롬프트

사용자가 직접 쓴 프롬프트만 판단합니다: 터미널 입력(`composer`), Remote Control(`bridge`), SDK·`claude -p`(`sdk`). 백그라운드 작업 알림, 예약 작업·`/loop`, 다른 세션이나 SendMessage로 온 메시지, observer, 자동 이어가기, 플러그인이 보낸 프롬프트, 출처 불명(`unclassified`) 등은 판단하지 않고 그대로 통과시키며 tier와 적용 값도 바꾸지 않습니다. 실행 중인 턴에 들어가는 프롬프트(턴이 도는 동안 입력해 큐에 들어간 것 포함)도 판단하지 않습니다. `/`로 시작하는 슬래시 명령도 판단하지 않습니다.

## 설치

Claude Code 2.1.289 이상이 필요합니다.

```bash
cd ~/IdeaProjects/tiergear
npm install
npm run build && npm link
ln -s ~/IdeaProjects/tiergear ~/.claude/skills/tiergear
claude plugin list | grep -A3 tiergear
```

`tiergear@skills-dir`, `Status: ✔ loaded`가 보이면 됩니다. `which tiergear`는 CLI 경로를 출력해야 합니다. 플러그인 hook은 세션 시작 시 불러오므로 설치 후 새 세션을 엽니다.

## 판단기

세 판단기 모두 TypeSafe의 `<baseUrl>/v1/systemone` 계약을 씁니다. 기본은 `jev`입니다.

| 프리셋 | 주소 | 모델 | 키 환경변수 | 시간 제한(첫 턴/이후) |
| --- | --- | --- | --- | --- |
| jev | `https://api.typesafe.ai` | `jev-latest` | `TYPESAFE_API_KEY` (필수) | 2000ms / 1200ms |
| laya | `http://localhost:11435` | `laya` | `OLLAYA_API_KEY` (선택) | 3000ms / 2500ms |
| kev | `http://localhost:8009` | `kev-latest` | `KEV_API_KEY` (선택) | 3000ms / 2000ms |

- jev는 키가 필요하고 TypeSafe 서버로 전송됩니다.
- laya는 로컬에서 `ollaya run laya`로 띄웁니다.
- kev는 로컬 또는 Modal에서 띄운 서버를 가리킵니다(`judgeBaseUrl`로 주소 변경).
- 판단기가 연속 3회 실패하면 해당 세션은 5분간 판단기를 쉬고 그동안 표가 아닌 현재 상태를 유지합니다.

## 표 A와 B

**표 A: tier가 처음 시작하는 모델**

| tier | Claude | Codex |
| --- | --- | --- |
| trivial | haiku | gpt-5.6-luna |
| quick | sonnet | gpt-5.6-terra |
| standard | sonnet | gpt-5.6-terra |
| deep | opus | gpt-5.6-terra |
| max | fable | gpt-5.6-terra |

**표 B: 모델별 effort** (`-`는 effort를 보내지 않음)

| 모델 | trivial | quick | standard | deep | max |
| --- | --- | --- | --- | --- | --- |
| haiku | - | - | - | - | - |
| sonnet | low | low | medium | high | max |
| opus | low | low | medium | xhigh | max |
| fable | low | low | medium | high | xhigh |
| gpt-5.6-luna (Codex) | low | low | medium | high | high |
| gpt-5.6-terra (Codex) | low | low | medium | xhigh | max |

Codex에서 deep과 max는 같은 `gpt-5.6-terra`를 쓰고 effort만 xhigh, max로 달라집니다.

세션이 effort 없는 모델(haiku)에 있으면 effort만으로는 올릴 수 없으므로, `switchModelMidSession=false`여도 tier를 올릴 때 그 tier의 모델로 바뀝니다(캐시가 한 번 끊깁니다).

### 표 바꾸기

`~/.config/tiergear/tables.json`에 바꿀 칸만 적으면 기본값에 덮어씌워집니다.

```json
{ "claude": { "effort": { "opus": { "deep": "max" } } } }
```

모델 칸은 `{"claude":{"models":{"deep":"opus"}}}`처럼 `models`에 적습니다. effort 값은 low, medium, high, xhigh, max 또는 `null`이고, 잘못된 값이나 JSON이 하나라도 있으면 **파일 전체를 무시**하고 기본 표를 씁니다(hook 로그에 남습니다). hook은 세션 시작 후 처음 필요할 때 한 번만 읽으므로 고친 뒤에는 새 세션을 엽니다.

## 플러그인 옵션

`/config`(플러그인 옵션)에서 바꿉니다.

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `judge` | `jev` | 판단기 프리셋: jev, laya, kev 중에서 고릅니다(`/config`에 목록으로 표시). 알 수 없는 값이면 jev를 쓰고 hook 로그에 한 번 남깁니다 |
| `judgeBaseUrl` | 프리셋 | 비우면 프리셋 주소 |
| `judgeModel` | 프리셋 | 비우면 프리셋 모델 |
| `judgeApiKey` | 프리셋 환경변수 | 비우면 TYPESAFE_API_KEY, OLLAYA_API_KEY, KEV_API_KEY (민감 값) |
| `switchModelMidSession` | `false` | 첫 턴 이후에도 모델을 바꿈(프롬프트 캐시가 끊김). 끄면 effort만 바뀜 |
| `minUpgradeConfidence` | `0.5` | tier를 올리는 최소 확신도 |
| `minDowngradeConfidence` | `0.85` | 내리기 후보로 세는 최소 확신도 |
| `downgradeStreak` | `2` | 한 단계 내리는 데 필요한 연속 턴 수 |
| `stuckConfidence` | `0.6` | 판단기의 막힘 확률이 이 값 이상이면 한 단계 올림 |
| `stuckFailures` | `3` | 같은 도구 실패가 이만큼 연속이면 한 단계 올림 |
| `firstTurnTimeoutMs` | 프리셋 | 첫 턴 지연 예산. 최대 8000ms(hook 전체 예산이 10초라 더 큰 값은 8000으로 줄입니다) |
| `turnTimeoutMs` | 프리셋 | 이후 턴 지연 예산. 최대 8000ms |

## 상태줄

모든 상태줄은 `tiergear ·`로 시작합니다.

- 적용: `tiergear · deep 0.91 → opus/xhigh` (세션 모델을 알면 항상 `모델/effort`로 표시합니다. 모델이 바뀌지 않아도 같은 형식이고, effort 없는 모델은 `-`입니다. 세션 모델을 아직 모르면 effort만 표시합니다)
- tier를 아직 정하지 못했으면 `unset`, 판단기 답이 없으면 확신도 자리에 `n/d`가 나옵니다.
- 유지: `tiergear · standard 0.62 · unchanged (<사유>)`

유지 사유: `no answer`(판단기 응답 없음), `low confidence`, `same tier`, `pinned`, `at floor`(바닥선이라 더 못 내림), `easier step N/M`(내리기 N번째 후보, M번 필요), `stuck at max`.

## CLI

```bash
tiergear launch "<brief>" [--agent claude|codex] [--worktree <path>] [--judge jev|laya|kev] [--judge-url <url>] [--judge-model <name>]
tiergear spawn  "<brief>" --name <task> [--agent claude|codex] [--repo <dir>] [--judge ...]
tiergear stats [days]
```

- `launch`: 판단 후 실행할 명령(`claude --model opus --effort xhigh` 등)을 출력합니다. Claude에서 `--worktree`를 주면 그 경로에 바닥선을 씁니다. 경로는 절대 실제 경로(심볼릭 링크 해석)로 바꿔 쓰므로 상대 경로를 줘도 그 폴더에서 연 세션이 찾습니다. `--agent codex`와 함께 주면 바닥선은 Claude 전용이라 쓰지 않고 한 줄 안내만 출력합니다.
- `spawn`: Orca worktree와 터미널을 만들고 판단된 모델과 effort로 에이전트를 띄운 뒤 브리프를 보냅니다. 결과를 JSON으로 출력합니다.
  - Claude가 "이 폴더를 신뢰하는가"를 물어도 **`spawn`은 대신 승인하지 않습니다.** 120초 안에 Orca에서 직접 승인하세요. 에이전트가 준비되지 않으면 브리프는 **보내지 않고**(종료 코드 1) 폴백 셸이 worktree에 남을 수 있습니다.
- `stats`: 기록된 결정 수, 변경 종류 집계, 판단기별 응답률과 평균 지연(기본 7일).
- 바닥선은 판단기가 실제로 결정했을 때만 씁니다. 판단기가 실패·무응답·낮은 확신도라 standard로 대체했다면 쓰지 않고 경고를 출력합니다.
- CLI의 판단 시간 제한은 5000ms입니다.

CLI는 플러그인 옵션을 읽지 못하므로 플래그, 환경변수, 프리셋 순으로 설정을 찾습니다.

| 변수 | 의미 |
| --- | --- |
| `TIERGEAR_JUDGE` | 판단기 이름(기본 jev) |
| `TIERGEAR_JUDGE_URL` | 판단기 주소 |
| `TIERGEAR_JUDGE_MODEL` | 판단기 모델 |
| `TIERGEAR_JUDGE_API_KEY` | 키(없으면 프리셋의 키 환경변수) |

## 저장 위치

| 대상 | 위치 |
| --- | --- |
| 표 | `~/.config/tiergear/tables.json` |
| 바닥선 (유효 24시간) | `~/.local/state/tiergear/floors/<fnv1a(worktree)>.json` |
| 결정 로그 (파일당 1000줄) | `~/.local/state/tiergear/decisions/<name>.jsonl` |
| 세션 기록 (7일 보존, 최신 200개까지) | 플러그인 `$.store`의 `session:<id>` (첫 프롬프트는 2000자로 줄여 저장) |

프롬프트 원문은 로그에 남기지 않습니다.

## 비용

- 모델 변경과 세션 중 effort 변경은 둘 다 messages 프롬프트 캐시를 무효화합니다(Anthropic 문서). 첫 턴은 캐시가 없어 비용이 없습니다.
- 그래서 세션 중에는 effort만 바꾸는 것이 기본이고, 내리기는 높은 확신도가 연속될 때만 일어나 변경 빈도를 줄입니다.
- haiku처럼 effort가 없는 모델에서 올릴 때는 모델이 바뀌어 캐시가 한 번 끊깁니다.
- 판단기 호출 자체의 비용과 지연이 매 프롬프트에 붙습니다(위 시간 제한 안에서).

## 판단기로 가는 데이터

- 첫 턴: 첫 프롬프트(길면 앞뒤만).
- 이후 턴: 첫 프롬프트, 최근 6개 메시지(각각 길면 앞뒤만, 사용한 도구 이름 포함), 다음 프롬프트, 수정한 파일 수, 반복 실패 횟수, 현재 tier와 effort.
- jev는 외부(TypeSafe)로 전송됩니다. laya와 kev는 로컬 서버에 머뭅니다(kev를 Modal에 띄우면 그쪽으로 갑니다).
- 판단하지 않는 프롬프트는 위 "판단하는 프롬프트"를 보세요. 판단하지 않은 프롬프트는 판단기로 가지 않습니다.

## 제한

- Codex는 띄울 때만 모델과 effort를 정합니다(`launch`/`spawn`). 세션 중 조정은 Claude Code만 됩니다.
- hook은 early-access 기능이라 Claude Code 업데이트로 계약이 바뀔 수 있습니다. `types/claude-code.d.ts`는 Claude Code 2.1.289가 만든 선언 파일입니다. 업데이트 후에는 엔진이 플러그인 옆에 새로 쓰는 `.claude-plugin/types/claude-code/index.d.ts`로 교체합니다.
- 확신도 기준값(0.5, 0.85, 0.6)은 Jev 기준입니다. 다른 판단기는 `tiergear stats`로 응답률과 지연을 보고 옵션을 조정하세요.
- 서브에이전트 요청은 건드리지 않고, 메인 루프 요청만 바꿉니다.
