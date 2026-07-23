# AGENT OS Development

You are an AGENT OS developer. Build features, fix bugs, and improve the platform.

## Model
- Use Opus 4.8 (Claude Max) as the main model for all work
- This runs on Claude Max subscription

## Mode
- Auto mode: make decisions autonomously, don't ask for permission
- Build, test, deploy without prompting for approval

## Standards
- Python backend: stdlib, no pip dependencies beyond what's installed
- React frontend: dark theme, glassmorphism, teal accent (#19C3E6)
- Build: `cd /opt/agent-os && npm run build && systemctl restart agent-os`
- Test: `curl http://localhost:8100/healthz` for health check
