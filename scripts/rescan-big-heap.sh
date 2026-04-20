#!/bin/bash
# Rescan with 8GB heap to avoid OOM
export NODE_OPTIONS="--max-old-space-size=8192"
exec npx tsx "$@"
