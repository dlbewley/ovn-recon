# bd (beads) in this repo

This project uses **[beads](https://github.com/gastownhall/beads)** (`bd`) for issue tracking. The **canonical store is Dolt** (embedded under `.beads/`, not copied to GitHub as normal files). Cross-machine sync uses the same Git remote as code, with history under **`refs/dolt/data`**.

**Docs:** https://gastownhall.github.io/beads/

## Essentials

```bash
bd onboard          # First-time snippet for agents
bd prime            # Workflow context + memories
bd ready --json     # Unblocked work
bd dolt push        # Publish Dolt history to origin (with git push)
bd dolt pull        # Fetch Dolt history from origin
bd bootstrap        # New clone: wire remote + pull Dolt data if present
```

Do not treat committed JSONL as the source of truth; optional local export is `bd export` if you need a file snapshot.
