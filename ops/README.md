# ops — host configuration that lives outside the app

The app runs from this repo, but some of what keeps Max Gleam working lives in
`/etc` on the host and is **not** captured by a git checkout or `./deploy.sh`:
scheduled sweeps in `/etc/cron.d/`. If the host is rebuilt or reprovisioned,
those are gone and the sweeps silently stop. This directory is the
version-controlled source of truth for them.

## Cron sweeps

`cron.d/` holds one file per scheduled job (faithful copies of the live
`/etc/cron.d/maxgleam-*` entries). To (re)install them on a host:

```
sudo ./ops/install-cron.sh
```

Idempotent — safe to re-run; it overwrites with identical content and nudges
cron to pick them up.

| Job | Schedule | Tool | Log |
|-----|----------|------|-----|
| `maxgleam-signoff`   | hourly            | `tools/maxgleam_signoff_sweep.py` | `/var/log/maxgleam-signoff.log` |
| `maxgleam-growth`    | every 30 min      | `tools/maxgleam_growth_sweep.py all` | `/var/log/maxgleam-growth.log` |
| `maxgleam-scheduler` | daily 04:00 UTC   | `tools/maxgleam_scheduler.py generate` | `/var/log/maxgleam-scheduler.log` |
| `maxgleam-gps-prune` | daily 04:15 UTC   | `tools/maxgleam_gps_prune.py` | `/var/log/maxgleam-gps-prune.log` |
| `maxgleam-gps-prune-verify` | daily 04:25 UTC | `tools/maxgleam_gps_prune_verify.py` | `/var/log/maxgleam-gps-prune-verify.log` |

All four tools are idempotent and load `/etc/agent-os.env` themselves, so cron
(which does not read the systemd `EnvironmentFile`) still sees the right DB
paths and the `MAXGLEAM_NOTIFY_DRY_RUN` switch.

> Note: `install-cron.sh` is intentionally **not** wired into `deploy.sh` —
> deploy runs unprivileged-ish and shouldn't rewrite `/etc` on every push.
> Run it explicitly when provisioning a host or after changing a schedule here.
