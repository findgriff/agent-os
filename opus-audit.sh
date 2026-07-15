#!/bin/bash
cd /opt/agent-os
claude -p "Audit and fix all AGENT OS features" < /tmp/opus-audit.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 45
