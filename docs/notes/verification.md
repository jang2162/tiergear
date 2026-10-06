# 구현 전 확인 결과 (Task 0)

확인일: 2026-10-06. 설치된 Claude Code 2.1.290, Codex CLI 0.157.1, Orca 1.4.220.

## 1. hook 타입 파일

- Task 0 당시 `claude -p "/plugin-types"`는 비대화형에서 실행되지 않아 2.1.274 임시본을 썼다.
- 최종 수정 라운드(2026-10-06)에서 Claude Code 2.1.289 번들의 `plugin-authoring/types/claude-code.d.ts`로 교체했다(첫 줄 `// Written by Claude Code 2.1.289.`). 교체 후 `npm run typecheck`는 수정 없이 통과했다. 2.1.289부터는 엔진이 플러그인을 불러올 때 `.claude-plugin/types/claude-code/index.d.ts`에 같은 파일을 써 준다.

## 2. hook 계약 (types/claude-code.d.ts 2.1.289 기준으로 재확인)

- **`turn.step` 입력**(`TurnStepInput`, 8867행): `turnId`, `index`, `model: string`, `effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number`, `messageCount`, `agentId?`. 문서 문구: "A hook rewrites `model` or `effort` going down; the rest is pinned." 재작성은 `next({ ...e, model })`.
- **`model`이 alias인지 전체 id인지 (2.1.289에서도 미해결)**: 2.1.289의 `TurnStepInput.model` 문구는 "Which model the request names, as the engine resolved it for this step (the session's, a fallback's). `next({ ...e, model })` names another."이다. 읽는 값은 엔진이 해석한 id이고, 재작성에 alias를 받는다는 문구는 여전히 `turn.step`에 없다("an alias resolves like the tool's parameter"는 `agent.spawn`에만 있다). **결론: 타입으로는 확정 불가.** 그래서 hook은 계속 전체 id(`claudeModelId`)로 재작성하고, 모델을 유지할 때는 엔진의 id(`claude-opus-5-5[1m]` 같은 접미사 포함)를 그대로 둔다. 실제 세션 확인이 필요하다.
- **`effort` 키를 빼고 `next`에 넘기면 유지되는지 (2.1.289에서도 미해결)**: "Pinned: a different value is refused, one left out is kept"는 여전히 pinned 필드(`agentId` 등)에만 있고, `effort`는 "the session's setting or the model's default, absent for a model without effort; rewritable"이다. 생략 시 유지되는지, 효과 없음으로 보내는지 문구가 없다. **결론: 타입으로는 확정 불가.** hook은 effort 없는 모델(haiku)로 바꿀 때만 키를 지우고, 그 밖에는 값을 명시해 넘긴다. 실제 세션 확인이 필요하다.
- **`prompt.submit` 입력의 출처**(2.1.289 `PromptSubmitInput`): `origin: PromptOrigin`(필수, `e.origin.kind`), `turnId?: string`(실행 중인 턴 위에 입력됐거나 그 턴에 전달된 프롬프트에만 있음), `wait: boolean`. `PromptOrigin.kind` 값: `composer`, `bridge`, `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`(+`server`), `coordinator`, `observer`, `observer-activity`, `auto-continuation`, `unclassified`, `slack-ping`, `plugin`(+`name`, `asUser?`). R17에 따라 `composer`, `bridge`, `sdk`이면서 `turnId`가 없을 때만 판단한다.
- **`session.end`**: `reason: SessionEndReason`(classic SessionEnd의 `reason`과 같은 단어), `sessionId`, `resume`. `/clear`는 `reason: 'clear'`로 보이고 이후 프로세스는 새 세션 id로 이어지며 `session.start`는 오지 않는다. 그래서 hook의 메모리(applied, 세션 모델, 실패 추적, 엔진 보고값)는 세션 id별로 둔다.
- **userConfig `options`**: 2.1.289 `PluginOptions` 문서에 "A string field that declares `options` holds one of them: `/config` draws it as a picker over them, and a stored value outside them counts as unset, so its default applies."가 있다. `judge`에 `["jev","laya","kev"]`를 지정했고 `claude plugin validate .`가 통과한다.
- **`turn.step` 핸들러 형태**(`StreamHook`, 7928행): `async function* ($, e, next) {}`. 통과는 `return yield* next(e)`. 일반 함수는 타입 오류("A plain function is a type error here"). `next(e)`를 두 번 부르면 요청이 두 번 나간다. `$.turn.step`의 반환은 `HookStream<TurnStepChunk, TurnStepResult>`.
- **`tool.call` 입력**(`ToolCallEnvelope`, 8249행): 도구 이름 필드는 `e.tool`, 호출 id는 `tool_use_id`, 인자는 옆에 펼쳐진다(`e.command`). `tool`, `tool_use_id`, `agentId`는 예약 필드(재작성 거부).
- **`tool.call` 결과**(`ToolCallResult`, 8294행): `{ deny: string }` 또는 `{ result, context?, ref?, text?, isError? }`. core 결과는 `{ ref, result, text }`, 도구가 오류를 냈을 때 `{ ref, result, text, isError }`. 따라서 `isError`(boolean)와 `text`(string) 필드가 있다.
- **`$.store`**(2.1.289): 사용자 Claude Code 설정 디렉터리 아래 플러그인 전용 JSON 파일. 메서드 `get/set/delete/keys`(모두 Promise), 값은 JSON 직렬화 왕복, `set`은 "a store over 4 MiB of JSON text in all"이면 reject. **플러그인 단위로 세션을 넘어 유지된다.** 그래서 세션 기록은 첫 프롬프트 2000자, 최신 200개, 7일로 제한한다(R19).

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

## 5. 판단기 실측 (Task 4)

측정일: 2026-10-06. `npx tsx scripts/probe-judge.ts <name>`, 첫 턴 state(`{task}`), withStuck=false.

jev (프리셋 제한: 첫 턴 2000ms): 5개 모두 `ok:true`, tier 모두 해석됨(null 없음). 지연은 제한의 약 10%.

| 프롬프트 | tier | 확신도 | 지연 |
| --- | --- | --- | --- |
| what is the version in package.json? | trivial | 1.00 | 274ms |
| rename the variable `cnt` to `count` in src/a.ts | trivial | 0.89 | 193ms |
| add a --dry-run flag to the deploy script and test it | standard | 0.65 | 185ms |
| the payment webhook double-charges some customers; find out why and fix it | deep | 0.97 | 188ms |
| ok continue | standard | 0.43 | 216ms |

- `ok continue`(맥락 없는 첫 턴)는 확신도 0.43으로 minUpgradeConfidence 0.5 미만. 맥락이 없어 예상된 결과.
- laya/kev: server not running — pending user check (`localhost:11435/api/tags` 무응답, `localhost:8009/v1/systemone` 연결 실패 000).

## 사용자 확인 대기 (Pending user checks)

Task 9의 설치와 실제 세션 확인은 모든 Claude Code 세션에 영향을 주므로(R16) 실행하지 않았다. 아래를 사용자가 직접 수행한다.

1. **설치**: `npm run build && npm link`, `ln -s ~/IdeaProjects/tiergear ~/.claude/skills/tiergear`, `claude plugin list | grep -A3 tiergear`. 기대값: `tiergear@skills-dir`, `Status: ✔ loaded`, `which tiergear`가 경로 출력.
2. **실제 세션 확인** (새 세션에서 순서대로, 상태줄을 이 문서에 기록):
   1. `README의 제목을 알려줘` → 낮은 tier, 첫 턴이라 모델 변경(예: `→ haiku/-` 또는 `→ sonnet/low`).
   2. `이 프로젝트에 결제 재시도 큐를 설계해줘` → 높은 tier로 `up`. 모델은 그대로이고 effort만 그 모델 열의 값(haiku였다면 모델이 바뀜).
   3. `ㅇㅋ 계속` 두 번 → 첫 번은 유지(`easier step 1/2` 또는 `same tier`), 낮아져도 한 단계만.
   4. `!pin 그대로 진행` → `unchanged (pinned)`. 이후 요청은 세션 자체의 모델과 effort로 나간다.
   5. 새 세션에서 첫 판단 뒤 `/model`이나 `/effort`로 직접 바꾸고 프롬프트를 보내면 hook 로그에 `manual model/effort change — routing paused for this session`이 한 번 남고 이후 `unchanged (pinned)`.
   6. hook 계약 두 가지(alias 재작성 허용 여부, effort 생략 시 유지 여부)를 실제 요청으로 확인한다(위 2번).
   7. `tiergear stats 1`로 기록 확인. `claude --resume`으로 같은 세션을 열어 프롬프트 하나를 보내고 상태줄이 이전 tier에서 이어지는지 확인(`$.store` 유지).
3. **Laya/Kev**: 두 서버가 실행 중이 아니어서 측정하지 못했다. 서버를 띄운 뒤 `npx tsx scripts/probe-judge.ts laya` 와 `npx tsx scripts/probe-judge.ts kev`로 응답률과 지연을 재고, 필요하면 `/config`에서 `judge`를 바꿔 2-1, 2-2를 반복한다.
