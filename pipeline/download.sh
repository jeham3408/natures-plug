#!/usr/bin/env bash
# Download the open raw data. About 6 GB, most of it the Diskos report texts.
# Usage: NP_DATA=/path/to/raw ./download.sh
set -euo pipefail
D="${NP_DATA:-./raw}"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
mkdir -p "$D"/{force2020,factpages,diskos,geo,derived}

# FORCE 2020 well logs (118 wells, CC BY 4.0)
for f in "LAS_files_Force_2020_all_wells_train_test_blind_hidden_final.zip"; do
  [ -s "$D/force2020/$f" ] || curl -sL -o "$D/force2020/$f" "https://zenodo.org/api/records/4351156/files/$f/content"
done
[ -d "$D/force2020/las" ] || (mkdir -p "$D/force2020/las" && cd "$D/force2020/las" && unzip -q -o "../LAS_files_Force_2020_all_wells_train_test_blind_hidden_final.zip")

# FactPages tables (Norwegian Offshore Directorate, NLOD 2.0)
for t in wellbore_development_all wellbore_exploration_all wellbore_casing_and_lot wellbore_mud wellbore_formation_top field; do
  [ -s "$D/factpages/$t.csv" ] || curl -sL -m 300 -o "$D/factpages/$t.csv" \
    "https://factpages.sodir.no/public?/Factpages/external/tableview/$t&rs:Command=Render&rc:Toolbar=false&rc:Parameters=f&IpAddress=not_used&CultureCode=en&rs:Format=CSV&Top100=false"
done

# Diskos report texts (FORCE, CC BY 4.0) - 5.7 GB
[ -s "$D/diskos/Norway_Diskos_reports.csv" ] || curl -L -C - -o "$D/diskos/Norway_Diskos_reports.csv" \
  "https://zenodo.org/api/records/10775273/files/Norway%20-%20Diskos%20reports.csv/content"

# Map geometry: field outlines, quadrants and CO2 licences from FactMaps, land from Natural Earth (public domain)
B="https://factmaps.sodir.no/api/rest/services/Factmaps/FactMapsWGS84/MapServer"
for L in 502:fields 803:quadrants 626:co2_licences; do
  id="${L%%:*}"; nm="${L##*:}"
  [ -s "$D/geo/$nm.geojson" ] || curl -sL -m 180 -A "$UA" -G "$B/$id/query" --data-urlencode "where=1=1" --data-urlencode "outFields=*" --data-urlencode "f=geojson" --data-urlencode "outSR=4326" -o "$D/geo/$nm.geojson"
done
[ -s "$D/geo/ne_10m_land.geojson" ] || curl -sL -o "$D/geo/ne_10m_land.geojson" "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
echo "Raw data is in $D"
