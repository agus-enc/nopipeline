#!/bin/sh
# Installed as /usr/bin/nopipeline by the rpm, deb and Arch recipes. Node runs the cli straight from its .ts source, which
# needs a Node built with TypeScript support; the Debian and Ubuntu archive Node is not. Say so instead of failing with
# ERR_UNKNOWN_FILE_EXTENSION.
# NOPIPELINE_TEST_NODE and NOPIPELINE_TEST_CLI exist only for the test suite; they are not a supported interface and may
# change or go away without notice.
node=${NOPIPELINE_TEST_NODE:-/usr/bin/node}
cli=${NOPIPELINE_TEST_CLI:-/usr/share/nopipeline/src/cli.ts}

"$node" -e 'process.exit(process.features.typescript ? 0 : 3)' 2>/dev/null
status=$?
if [ "$status" -eq 3 ]; then
  echo "nopipeline: this Node.js ($("$node" --version)) cannot run TypeScript. Install Node.js 22.22 or newer from NodeSource (https://github.com/nodesource/distributions), which can." >&2
  exit 1
elif [ "$status" -ne 0 ]; then
  echo "nopipeline: /usr/bin/node is missing or broken; install Node.js 22.22 or newer." >&2
  exit 1
fi
exec "$node" "$cli" "$@"
