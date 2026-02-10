# Agent Instructions

## Environment Setup

Environment variables are set in `setup_env.sh` and should be sourced before running any commands.

```bash
source setup_env.sh
```

## Code Guidelines

When implementing any UI element consider leveraging [PatternFly](https://www.patternfly.org/) to remain consistent with the OpenShift 4.20 and later console.

## Task Management

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

### Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

### PR Command Note

When creating PRs with `gh pr create`, do not include Markdown backticks in an inline `--body` string because the shell can interpret them.

- Prefer `gh pr create --body-file <path>` for multiline content
- If using `--body`, avoid backticks or escape them explicitly

## Rebuild and Deploy

During development, changes can be built and deployed to cluster with the following commands. Once complete the console should be reloaded to see the changes.

Please allow up to 2 minutes for the command completion.

```bash
source setup_env.sh && \
   make build push && \
   oc rollout restart deployment/$APP_NAME -n "$APP_NAMESPACE" && \
   oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```
