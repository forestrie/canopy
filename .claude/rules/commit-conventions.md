---
name: commit-conventions
description: "Forestrie commit message limits: title <=79 chars, body lines <=72, no Co-Authored-By, repository-configured author only."
when_to_use: Writing a commit message in a Forestrie org repository.
user-invocable: false
---

# Commit conventions

Applies to Forestrie org repositories.

- Commit titles must be no more than **79** characters
- Commit body lines must be no more than **72** characters
- Never include `Co-Authored-By` lines in commit messages
- Use only the repository's configured git user as the commit author

**univocity-tools** additionally uses [Conventional Commits](https://www.conventionalcommits.org/)
with title ≤100 chars — follow that repo's AGENTS.md when working there.
