#!/usr/bin/env bash
# Run the Ktor fake daemon so the deck has something to talk to without a Mac Studio.
#
#   scripts/fakedaemon.sh                # idle scenario on 47291
#   scripts/fakedaemon.sh warnCrossing   # walks weekly_all past warn and critical
#   scripts/fakedaemon.sh freeze         # hard-freezes the first session on step 3
#   scripts/fakedaemon.sh machineDrop    # stops the heartbeat so the machine ages to DEAD
#
# From the emulator the host is 10.0.2.2; from the phone use the Mac's tailnet address.
set -euo pipefail
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
SCENARIO=${1:-idle}
PORT=${PORT:-47291}
exec ./gradlew :fakedaemon:run --args="--port $PORT --scenario $SCENARIO"
