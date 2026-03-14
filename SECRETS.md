# Secret Management

## Policy

- **Never commit real secrets** (API keys, private keys, tokens) to this repository.
- All secrets must be provided via environment variables or a secrets manager at runtime.
- The `.gitleaks.toml` allowlist covers only well-known test keys (e.g., Hardhat account #0).

## Pre-commit Hook

This repository uses [gitleaks](https://github.com/gitleaks/gitleaks) as a pre-commit hook to catch accidental secret commits before they reach git history.

### Setup

```bash
pip install pre-commit
pre-commit install
```

After installation, gitleaks runs automatically on every `git commit`. To run manually:

```bash
pre-commit run gitleaks --all-files
```

### Full History Scan

To scan the entire git history for leaked secrets:

```bash
gitleaks detect --source . --report-path gitleaks-report.json
```

## Known Test Keys

The following keys are intentionally present in test files and are **not real secrets**:

| Key | Source | Usage |
|-----|--------|-------|
| `0xac0974...f2ff80` | Hardhat account #0 | Used in test fixtures for x402 payment verification and social relay tests |

## Environment Variables

Runtime secrets should be set via environment variables. See `.env.example` (if present) or service-specific documentation for required variables.
