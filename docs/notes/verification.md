# 구현 전 확인 결과 (Task 0)

확인일: 2026-10-06. 설치된 Claude Code 2.1.290, Codex CLI 0.157.1, Orca 1.4.220.

## 1. hook 타입 파일 (주의: 임시본)

- `claude -p "/plugin-types"`는 비대화형에서 실행되지 않았다("이 세션에 설치되어 있지 않음" 응답). 선언 파일이 만들어지지 않았다.
- `types/claude-code.d.ts`는 **2.1.274 임시본**이다(첫 줄 `// Written by Claude Code 2.1.274.`). 브리프의 기대값은 2.1.289 이상이므로 **사용자가 tiergear 디렉터리의 대화형 세션에서 `/plugin-types`를 실행해 다시 만들어야 한다.** 재생성 후 아래 2번 항목을 다시 확인한다.

## 2. hook 계약 (types/claude-code.d.ts 2.1.274 기준)

- **`turn.step` 입력**(`TurnStepInput`, 8867행): `turnId`, `index`, `model: string`, `effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number`, `messageCount`, `agentId?`. 문서 문구: "A hook rewrites `model` or `effort` going down; the rest is pinned." 재작성은 `next({ ...e, model })`.
- **`model`이 alias인지 전체 id인지**: `turn.step` 타입 문서는 명시하지 않는다. `model`은 "as the engine resolved it for this step"이라고만 되어 있어 읽을 때는 엔진이 해석한 값(전체 id일 가능성이 높음)이다. alias를 받는다는 문구는 `turn.step`에는 없고, 다른 곳(`agent.spawn`의 model 등)에만 "alias (`haiku`) or a full id"로 나온다. **결론: `turn.step`에 alias를 넘겨도 되는지는 타입만으로 확정 불가. 안전하게 전체 id를 쓰거나, 실제 세션에서 alias 재작성이 통하는지 실행 검증해야 한다.**
- **`effort` 키를 빼고 `next`에 넘기면 유지되는지**: 문서는 "left out is kept"를 `turnId`/`index`/`agentId` 같은 pinned 필드에만 적고(8896행: "Pinned: a different value is refused, one left out is kept"), `effort`에는 적지 않았다. `effort`는 "absent for a model without effort; rewritable"이다. **결론: 생략 시 유지된다는 보장 문구 없음. 확정 불가, 실행 검증 필요.** 값을 바꾸지 않을 때는 `{ ...e }` 그대로 넘기는 것이 안전하다.
- **`turn.step` 핸들러 형태**(`StreamHook`, 7928행): `async function* ($, e, next) {}`. 통과는 `return yield* next(e)`. 일반 함수는 타입 오류("A plain function is a type error here"). `next(e)`를 두 번 부르면 요청이 두 번 나간다. `$.turn.step`의 반환은 `HookStream<TurnStepChunk, TurnStepResult>`.
- **`tool.call` 입력**(`ToolCallEnvelope`, 8249행): 도구 이름 필드는 `e.tool`, 호출 id는 `tool_use_id`, 인자는 옆에 펼쳐진다(`e.command`). `tool`, `tool_use_id`, `agentId`는 예약 필드(재작성 거부).
- **`tool.call` 결과**(`ToolCallResult`, 8294행): `{ deny: string }` 또는 `{ result, context?, ref?, text?, isError? }`. core 결과는 `{ ref, result, text }`, 도구가 오류를 냈을 때 `{ ref, result, text, isError }`. 따라서 `isError`(boolean)와 `text`(string) 필드가 있다.
- **`$.store`**(2664행): "This plugin's own key-value store, kept between sessions and hot reloads; values are JSON data." 사용자 Claude Code 설정 디렉터리 아래 플러그인 전용 JSON 파일. 메서드 `get/set/delete/keys`(모두 Promise), 값은 JSON 직렬화 왕복, 전체 4 MiB 초과 시 reject. **플러그인 단위로 세션을 넘어 유지된다고 명시돼 있다.**

## 3. Codex 모델과 effort

출처: `~/.codex/config.toml`, `~/.codex/models_cache.json`(client_version 0.157.1, 2026-10-06 갱신). `codex --help`에는 모델 목록 없음(`-m, --model <MODEL>`만).

- 현재 설정: `model = "gpt-5.6-terra"`, `model_reasoning_effort = "high"`.
- 캐시의 모델 목록과 지원 effort:

| slug | visibility | effort |
| --- | --- | --- |
| gpt-6-luna | list | low, medium, high, xhigh, max |
| gpt-5.6-terra | list | low, medium, high, xhigh, max, ultra |
| gpt-5.6-luna | list | low, medium, high, xhigh, max |
| gpt-5.5 | hide | low, medium, high, xhigh |
| gpt-reserve, codex-auto-review | hide | low, medium, high, xhigh, max |

- **spec 표 A·B와 대조**: `gpt-5.6-terra`와 `gpt-5.6-luna`는 실재한다. **`gpt-5.6-sol`, `gpt-6-astra`는 캐시에 없다.** 대신 `gpt-6-luna`가 있다(표에 없는 이름). 따라서 표 A의 deep(`gpt-5.6-sol`)과 max(`gpt-6-astra`) 칸은 이 머신의 Codex에서 확인되지 않는다. 계정/롤아웃에 따라 보이는 목록이 다를 수 있으므로 사용자 확인이 필요하다.
- effort 허용 값: `low`, `medium`, `high`, `xhigh`, `max`(+ terra만 `ultra`). 표 B가 쓰는 low/medium/high/xhigh는 모두 허용된다. 공식 문서 웹 조회는 하지 않았고 로컬 캐시만 근거로 했다.

## 4. Orca JSON 캡처 (실제 실행, synthetic 아님)

tiergear 저장소는 미등록이어서 `orca repo add --path /Users/jang2162/IdeaProjects/tiergear --json`으로 등록했다(repo id `8db22c76-2921-46d5-a9c5-efd9d698eaf4`, Orca에 남아 있음). worktree 삭제 명령: `orca worktree rm --worktree id:<repoId>::<path> --force --json`.

픽스처 위치 `tests/fixtures/orca/`. 모든 응답은 `{ id, ok, result|error, _meta }` 봉투.

| 항목 | 파일 | JSON 경로 |
| --- | --- | --- |
| worktree id | worktree-create.json | `result.worktree.id` = `<repoId>::<절대경로>` (경로는 `<repo>/.worktrees/tiergear/<name>`) |
| 터미널 handle (create) | terminal-create.json | `result.terminal.handle` (`term_<uuid>`); `result.terminal.title`, `worktreeId`도 있음 |
| wait satisfied | terminal-wait.json | `result.wait.satisfied`; 같은 객체에 `condition`, `status`, `exitCode`, `blockedReason` |
| 목록 title, handle | terminal-list.json | `result.terminals[].title`, `result.terminals[].handle` (+ `orphaned`, `agentIdentity`, `preview`) |
| send 수락 | terminal-send.json | `result.send.accepted`, `result.send.handle`, `result.warnings[]` |
| 오류 code | terminal-error.json | `error.code` (`ok:false`), 이 경우 `terminal_handle_stale` |

실측에서 이후 Task가 알아야 할 점:
- `terminal wait --for tui-idle`이 `satisfied:false`, `blockedReason:"agent-trust-workspace"`로 끝났다. 새 worktree에서 Claude Code가 "이 폴더를 신뢰하는가" 확인을 띄워 idle이 되지 않았다. 신뢰되지 않은 새 worktree에서는 `blockedReason`을 처리해야 한다(`satisfied` 확인 후 send 규칙 유지). 이번에는 안내대로면 보내지 말아야 했으나 픽스처 캡처를 위해 send를 실행했다.
- 목록의 `title`은 만든 제목(`tiergear-probe`)이 아니라 에이전트가 바꾼 `claude`였다. 제목으로 터미널을 찾지 말고 create 시 받은 handle을 쓴다.
- `worktree create`는 별도 폴백 셸 터미널(`orphaned:true`, title `..iergear-probe`)을 하나 더 만들었다. 목록에 2개가 나온다.
- send 결과에 `warnings`: "input was accepted, but this provider cannot report delivery"(`provider:"unsupported"`). `accepted:true`여도 전달 확인은 아니다.
- 존재하지 않는 handle `nope`는 `terminal_handle_stale`이었다(`terminal_not_found` 같은 별도 code 아님).
- 정리: `tiergear-probe` worktree와 브랜치 `jang2162/tiergear-probe`는 삭제 확인(`git worktree list`, `git branch`). 빈 `.worktrees/tiergear/` 디렉터리는 남았다(untracked 항목으로 보이지 않음).
