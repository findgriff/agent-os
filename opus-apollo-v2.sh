#!/bin/bash
cd /opt/agent-os
export OPENAI_API_KEY="[REDACTED]"
claude -p "Build Apollo v2 with GPT-4o + TTS" < /tmp/opus-apollo-v2.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 40
