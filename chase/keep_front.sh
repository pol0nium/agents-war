#!/bin/bash
# Keeps Google Chrome in front so Turnstile keeps minting tokens for the chase tab (a hidden/occluded tab stops producing
# tokens). Since 2026-10-06 12:40 UTC: AROUND THE CLOCK (a rival took #1 at lunchtime while the day-hidden tab starved).
# Brings Chrome forward every 3 min.  Start: nohup chase/keep_front.sh >/dev/null 2>&1 &   Stop: pkill -f keep_front.sh
while true; do
  open -a "Google Chrome"
  sleep 180
done
