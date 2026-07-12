---
name: Bug report
about: Report something that's broken or behaving unexpectedly
title: "[bug] "
labels: bug
---

## Summary

<!-- One or two sentences describing the problem. -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What happened instead. -->

## Environment

- Maestro version: <!-- `npx maestro --version` or check package.json -->
- Node version: <!-- `node --version` -->
- OS:
- Profile: <!-- `default` / `ollama-only` / `cloud-only` -->

## Backend

- Provider(s) in use: <!-- Ollama / LiteLLM / Featherless / Bedrock -->
- Models:

## `maestro doctor` output

```
<!-- paste output of `maestro doctor` — redact any keys -->
```

## `maestro route` (if routing-related)

```
<!-- paste output of `maestro route "<your prompt>" --debug` — redact any keys -->
```

## Config (redacted)

<!-- Paste the relevant section of ~/.maestro-ai/config.json with API keys removed. -->