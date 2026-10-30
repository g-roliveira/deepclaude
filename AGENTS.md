# AGENTS.md

This project launches Claude Code with **DeepSeek or Anthropic**; it does not
launch Codex as the model client. Codex can maintain the project and use its skill.

Read [CLAUDE.md](CLAUDE.md) for current architecture, CLI/authentication contracts,
streaming invariants and editing guidance. It is shared guidance for both agents.

- Bash on Linux is the only supported launcher.
- DeepSeek normal and remote modes use the Node proxy; native Anthropic launches
  return directly after Claude Code exits.
- Keep Anthropic protocol/env variables and remote bridge authentication.
- Preserve DeepSeek vision, Files, thinking history, native tools, cache metadata,
  context headroom, costs, logs, cancellation and shutdown handling.
- Do not restart active proxies or change private credentials/sessions as part of
  source refactoring.
- Runtime has no external dependencies or build step. Run npm test and
  npm run refactor:verify for regressions, coverage, AST/static analysis and guards.
- Use .agents/skills/surgical-refactor/SKILL.md for authorized removals. The same
  skill is exposed through .claude/skills/surgical-refactor.
- Active enforce policy prevents reintroducing native Windows support or providers
  other than DeepSeek and Anthropic. Examples in the skill are not authorization
  for additional removals. Never refresh baseline just to accept a regression.
- Tools are installed locally under the skill's tooling directory. Do not add
  redundant global tools or runtime dependencies.
- Mutation checks focus on path construction and startup provider validation;
  they do not prove equivalence of the whole proxy.

See [provider removal evidence](docs/provider-removal.md) and
[skill documentation](docs/surgical-refactor.md).
