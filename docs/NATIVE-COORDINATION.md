# Optional Solo outcome coordination

The native worker bridge exposes seven project-bound coordination tools when
used with a verified Solo workspace. They are not required for terminal or
other workspace adapters. No Solo installation, global configuration or
machine-specific project path is embedded in the module.

- `coord_todo_list`: list bridge-owned outcomes.
- `coord_todo_create`: supply a stable `key`, `title`, and `body`.
- `coord_todo_update`: supply the returned `id`, `title`, `body`, and `status`
  (`open`, `in_progress`, `backlog`, or `completed`).
- `coord_scratchpad_list`: list bridge-owned scratchpad metadata.
- `coord_scratchpad_read`: read a returned `id`.
- `coord_scratchpad_create`: supply a stable `key`, `name`, and `content`.
- `coord_scratchpad_append`: supply the returned `id`, current
  `expectedRevision`, and `content` to append.

The project and installed Solo executable come from the launch binding.
Only explicitly recorded bridge-owned IDs can be changed. Existing user
records are not adopted by title, deleted, moved, or overwritten. Scratchpad
updates use revision checks; all writes require readback. Concurrent bridge
requests use a bounded project lock. A stale lock fails safely and requires
inspection rather than automatically deleting it.

Creation retries with the same key and exact original input reuse the owned
record. Changed input with that key is rejected: use the update tool instead.
Before creation, the bridge persists a pending key. If the CLI completed
creation but failed before returning a verifiable ID or before local ownership
was saved, retries with that key stop and require inspection of Solo first.
This is an explicit ambiguous external-write boundary, not exactly-once
delivery across a process crash.

Use outcome names and acceptance criteria, not telemetry, as todos. Include
the full Taskavel task link in the body when applicable. Completing a Solo
todo does not complete its Taskavel task or prove application acceptance.
Taskavel integration is separate and is not granted by these tools. Never
store credentials, hidden reasoning, or unrelated project data in scratchpads.
