#!/bin/bash
# AGENT OS — auto build script
# Fires when Claude session limit resets. Runs Fable UI + Opus audit in sequence.

cd /opt/agent-os

# Wait a minute to ensure limit has actually reset
sleep 60

echo "=== Starting AGENT OS auto-build ==="
date -u

# Step 1: Fable UI polish — focus on visible logged-in UI
echo "=== Step 1: Fable UI polish ==="
cat > /tmp/fable-ui-spec.txt << 'FABLESPEC'
Polish the AGENT OS UI to look 10x more premium. Focus ONLY on what a logged-in user sees.

## Files to improve

### 1. Dashboard (pages/Dashboard.tsx)
- Add welcome header with CMDR GRIFF callsign
- Add quick-action cards: Agents, Mission Control, Galaxy, Apollo, Pipelines, Kanban
- Each card should have a hover animation (translateY -2px + glow shadow)
- Live activity ticker at the bottom
- KITT red (#EF4444) for Apollo accent, keep teal (#19C3E6) for the rest

### 2. Sidebar (components/Layout.tsx) — already improved, but add:
- Active nav item should glow with a coloured dot/bar on the left
- Icons should scale up subtly on hover
- Bottom accent glow on the active item

### 3. Global card styles (components/ui.tsx)
- Consistent glass-morphism cards with hover lift effects
- Add subtle grid background pattern to pages
- Smooth 200ms transitions everywhere
- Button press effect (scale 0.97)

### 4. All empty states
- Every page should have a beautiful empty state illustration/icon
- Use the page's accent colour

Do NOT change Apollo's Orb or Waveform components. Those are final.

Build and deploy when done: cd /opt/agent-os && npm run build && systemctl restart agent-os
FABLESPEC

claude -p "Polish AGENT OS UI 10x" < /tmp/fable-ui-spec.txt --model fable --allowedTools "Read,Edit,Write,Bash" --max-turns 25
FABLE_EXIT=$?
echo "Fable exit: $FABLE_EXIT"

# Step 2: Opus on max — feature audit
echo "=== Step 2: Opus feature audit ==="
claude -p "Audit and fix all AGENT OS features" < /tmp/opus-audit.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 45
OPUS_EXIT=$?
echo "Opus exit: $OPUS_EXIT"

# Step 3: Final build and deploy
echo "=== Step 3: Final build ==="
cd /opt/agent-os && npm run build && systemctl restart agent-os
echo "=== Auto-build complete ==="
date -u
echo "Fable: $FABLE_EXIT | Opus: $OPUS_EXIT"
