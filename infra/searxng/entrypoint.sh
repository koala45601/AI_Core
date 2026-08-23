#!/bin/sh
set -eu

cp /usr/local/share/alpha-searxng/settings.yml /etc/searxng/settings.yml
exec /usr/local/searxng/entrypoint.sh "$@"
