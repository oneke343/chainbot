# Project AI Agent Instructions

This file is the entry point for AI agents working in this repository. It is
**user-owned** — `wmill` never overwrites it. Add your project-specific
guidance below the include line.

The line below pulls in Windmill's managed CLI guidance (skills, deploy flow,
debugging jobs, etc.). Refresh it with `wmill refresh prompts`. Remove the
include line if you don't want the managed guidance in this project.

@AGENTS.wmill.md

## Project-specific instructions

Deploy mode: git push (GitHub Actions runs `wmill sync push`; scheduled Actions run
`wmill sync pull` and commit Windmill workspace changes back to `main`).

<!-- Add anything specific to this repo here. Examples:
     - Deploy commands or environments unique to this project.
     - Domain glossary, naming conventions, or "ask before X" rules.
     - Overrides for the managed guidance above (be explicit that they
       supersede the managed rule). -->
