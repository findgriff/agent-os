#!/bin/bash
cd /opt/agent-os
claude -p "Build Hermes Oracle + Fire Coral Search" < /tmp/opus-oracle-search.txt --model opus --effort max --allowedTools "Read,Edit,Write,Bash" --max-turns 40
