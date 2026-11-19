#!/bin/sh
# Start the whole Nature's Plug app: atlas, Green Clay predictor and seismic viewer.
#
#   ./start.sh          everything, served from the Linux PC through an ssh tunnel:
#                       http://127.0.0.1:8777/  (seismic viewer at /seismic/)
#   ./start.sh local    atlas and Green Clay predictor only, from this machine:
#                       http://127.0.0.1:8000/  (no Linux PC needed; the seismic page says so)
#
# The seismic back end needs the seismic cubes, which live on the Linux PC. It listens on
# 127.0.0.1 there only; this script forwards the port. Ctrl-C stops tunnel and server.
#
# Settings (environment): NP_HOST (default linux-pc), PORT (8777), NP_REMOTE_APP (app copy on
# the Linux PC), NP_CUBES (prepared cubes, name=folder ...), NP_PY (Python with numpy, scipy, Pillow).

set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = "local" ]; then
  echo "Nature's Plug (no seismic): http://127.0.0.1:8000/   Ctrl-C to stop"
  exec python3 -m http.server 8000 --bind 127.0.0.1
fi

HOST="${NP_HOST:-linux-pc}"
PORT="${PORT:-8777}"
APP="${NP_REMOTE_APP:-/mnt/ssd/Data/force-hackathon-2026/natures-plug}"
# One or more prepared cubes as name=folder; the first is shown by default.
CUBES="${NP_CUBES:-tne01=/mnt/ssd/Data/force-hackathon-2026/smeaheia/cubes/tne01 gn1101=/mnt/ssd/Data/force-hackathon-2026/smeaheia/cubes/gn1101 sleipner94=/mnt/ssd/Data/force-hackathon-2026/sleipner/cubes/sleipner94}"
PY="${NP_PY:-/mnt/ssd/Arbeid/.system/envs/geoscience/bin/python}"

echo "Nature's Plug: http://127.0.0.1:${PORT}/   seismic viewer: http://127.0.0.1:${PORT}/seismic/   Ctrl-C to stop"
# -tt gives the server a terminal, so it stops when this ssh session ends.
exec ssh -tt -o ExitOnForwardFailure=yes -L "${PORT}:127.0.0.1:${PORT}" "${HOST}" \
  "cd '${APP}/seismic/server' && exec '${PY}' server.py --data ${CUBES} --web '${APP}' --port ${PORT}"
