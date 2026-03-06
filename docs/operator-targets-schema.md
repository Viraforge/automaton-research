# Operator Targets Schema

Default path: `~/.automaton/distribution-targets.json`  
Config override: `AutomatonConfig.distribution.operatorTargetsPath`

Top-level format:
- JSON array of target objects.

Per-target fields:
- `project_id` (string, required): project ID receiving this target.
- `channel_id` (string, required): distribution channel ID (for example `social_relay`, `erc8004_registry`).
- `target_key` (string, required): stable key/slug/url used for matching and dedupe.
- `target_label` (string, optional): human-readable label for reports.
- `priority` (number, optional): integer priority; higher sorts first.
- `tags` (string array, optional): metadata only.

Behavior:
- Missing file: runtime logs warning and continues with no targets.
- Invalid JSON: runtime logs warning (`invalid JSON: ...`) and continues with no targets.
- Invalid entry shape: entry is skipped and does not stop runtime.
- Duplicate targets (`project_id + channel_id + target_key`): ignored on reload.

Reference example:
- [distribution-targets.example.json](/Users/damondecrescenzo/automaton-research/docs/distribution-targets.example.json)
