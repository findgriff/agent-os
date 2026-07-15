#!/bin/bash
cd /opt/agent-os
claude -p "Build Hermes Apollo voice agent" < /tmp/opus-apollo.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 45
