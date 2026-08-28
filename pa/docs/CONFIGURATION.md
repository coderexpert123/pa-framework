# PA Configuration Guide

This document describes configuration options and files for the Personal Assistant system.

## SLO Configuration

### Service-Level Objectives

SLO (Service-Level Objective) error budget tracking is available via `pa slo report`. The system tracks four services:

- **bot-reply-delivery**: 99.5% monthly target. Events are DLQ TTL expiries and death notices.
- **daily-mail-brief**: ≥95% monthly target. Events are missed 19:00/05:00 IST delivery windows.
- **catchup-heartbeat**: Gap <30min target. Events are heartbeat gaps >30min from app.log.
(Add your own services via `~/.pa/slo.yaml` — see `examples/slo.yaml.example`)

### SLO Configuration File

You can override default service definitions by placing `slo.yaml` at `~/.pa/slo.yaml`. See `examples/slo.yaml.example` for the format.

### Running SLO Reports

Generate a monthly SLO report:

```bash
pa slo report [--month YYYY-MM] [--config <path>]
```

The report computes error budgets deterministically from existing logs:
- DLQ file: `~/.pa/telegram-dlq.jsonl`
- App log: `~/.pa/app.log.jsonl`
- Mail brief: `~/.pa/daily-mail-brief/latest.json`

**Note:** SLO data feeds into the weekly digest summary. Error budget exhaustion does not freeze the self-improver in v1 (that hook is a follow-up once a month of data exists).
