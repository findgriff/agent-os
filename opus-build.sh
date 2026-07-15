#!/bin/bash
cd /opt/agent-os
claude -p "Build 7 AGENT OS features" < /tmp/opus-features.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 60
