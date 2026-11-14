#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'usage: build.sh /absolute/output/path' >&2
  exit 2
fi
case "$1" in /*) ;; *) printf '%s\n' 'output must be absolute' >&2; exit 2 ;; esac
if [ -e "$1" ] || [ -L "$1" ]; then
  printf '%s\n' 'output already exists' >&2
  exit 1
fi
for value in "${GOMODCACHE-}" "${GOCACHE-}" "${GOTMPDIR-}"; do
  case "$value" in /*) ;; *) printf '%s\n' 'task-local cache paths required' >&2; exit 2 ;; esac
  if [ ! -d "$value" ] || [ -L "$value" ]; then
    printf '%s\n' 'cache directory unavailable' >&2
    exit 2
  fi
done
export GOTOOLCHAIN=local GOWORK=off GOPROXY=off
if [ "$(go env GOVERSION)" != 'go1.27.3' ]; then
  printf '%s\n' 'unexpected Go toolchain' >&2
  exit 1
fi
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
output_dir=$(dirname -- "$1")
if [ ! -d "$output_dir" ] || [ -L "$output_dir" ]; then
  printf '%s\n' 'output directory unavailable' >&2
  exit 1
fi
temporary=$(mktemp "$output_dir/.public-chat-helper.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
cd "$source_dir"
go build -mod=readonly -trimpath -buildvcs=false -o "$temporary" .
chmod 0700 "$temporary"
ln "$temporary" "$1"
