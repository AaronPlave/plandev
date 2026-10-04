#!/usr/bin/env bash
# Simulation profile storage benchmark: shape, size and read cost of merlin.profile_segment for given datasets.
#   ./bench.sh <dataset_id> [<dataset_id> ...]
# Env (defaults = local "tol" pd stack):
#   PGHOST=localhost PGPORT=31144 PGDATABASE=plandev PGUSER=postgres_user PGPASSWORD=postgres_user
#   HASURA=http://localhost:31140/v1/graphql HASURA_ADMIN_SECRET (or HASURA_GRAPHQL_ADMIN_SECRET; pd stack graphql <stack>)
#   RUNS=5 (timed repetitions; median reported)  WINDOWS="1 day,7 days" (viewport widths)
set -euo pipefail
cd "$(dirname "$0")"
export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-31144} PGDATABASE=${PGDATABASE:-plandev}
export PGUSER=${PGUSER:-postgres_user} PGPASSWORD=${PGPASSWORD:-postgres_user}
HASURA=${HASURA:-http://localhost:31140/v1/graphql}
SECRET=${HASURA_ADMIN_SECRET:-${HASURA_GRAPHQL_ADMIN_SECRET:?set HASURA_ADMIN_SECRET (pd stack graphql <stack> prints it)}}
RUNS=${RUNS:-5}
IFS=, read -ra WINDOWS <<< "${WINDOWS:-1 day,7 days}"

q() { psql -X -At -v ON_ERROR_STOP=1 "$@"; }

# Median wall time (ms) of a SQL statement, as psql sees it (server execution + transfer to psql).
time_sql() {
  local sql=$1 out
  out=$( { echo '\timing on'; echo '\o /dev/null'; for _ in $(seq "$RUNS"); do echo "$sql;"; done; } | q 2>&1 \
    | sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' | sort -n)
  echo "$out" | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'
}

# Median time_total (s) and bytes of a Hasura request; $2 = extra curl args (e.g. gzip).
time_gql() {
  local body=$1; shift
  for _ in $(seq "$RUNS"); do
    curl -s -o /dev/null -w '%{time_total} %{size_download}\n' "$HASURA" "$@" \
      -H "x-hasura-admin-secret: $SECRET" -H 'x-hasura-role: aerie_admin' -H 'x-hasura-user-id: test' \
      -H 'content-type: application/json' --data-binary "$body"
  done | sort -n | awk '{t[NR]=$1; b[NR]=$2} END {m=int((NR+1)/2); printf "%.0f ms %d B", t[m]*1000, b[m]}'
}

for DS in "$@"; do
  echo "=== dataset $DS"
  q -v ds="$DS" -P tuples_only=off -P format=aligned -f stats.sql | sed 's/^/  /'

  # Largest profile and where its segments sit.
  TOP=$(q -F ' ' -c "
    select p.id, p.name, extract(epoch from min(s.start_offset)), extract(epoch from max(s.start_offset)), count(*)
    from merlin.profile p join merlin.profile_segment s on s.dataset_id = p.dataset_id and s.profile_id = p.id
    where p.dataset_id = $DS group by p.id, p.name order by count(*) desc, p.id limit 10")
  read -r PID PNAME FIRST LAST N <<< "$(head -1 <<< "$TOP")"
  TOPIDS=$(cut -d' ' -f1 <<< "$TOP" | paste -sd, -)
  [ -n "$PID" ] || { echo "  (no segments)"; continue; }
  echo "  largest profile: id $PID '$PNAME', $N segments, offsets ${FIRST}s .. ${LAST}s"
  SEL="select start_offset, dynamics, is_gap from merlin.profile_segment where dataset_id = $DS and profile_id = $PID"

  echo "  SQL whole profile:              $(time_sql "$SEL order by start_offset") ms"
  # Display reduction computed on the fly (no stored summary): 2000 buckets over the whole profile,
  # first/last offset, count and numeric min/max per bucket. Cost of reducing without a summary table.
  echo "  SQL whole profile, reduced 2k:  $(time_sql "
    select b, min(start_offset), max(start_offset), count(*),
           min(coalesce((dynamics->>'initial')::float8, case when jsonb_typeof(dynamics) = 'number' then dynamics::text::float8 end)),
           max(coalesce((dynamics->>'initial')::float8, case when jsonb_typeof(dynamics) = 'number' then dynamics::text::float8 end))
    from (select width_bucket(extract(epoch from start_offset), $FIRST, $LAST + 1, 2000) b, start_offset, dynamics
          from merlin.profile_segment where dataset_id = $DS and profile_id = $PID) x group by b") ms"

  WHOLE="{\"query\":$(jq -Rs . < profile-since.graphql),\"variables\":{\"datasetId\":$DS,\"name\":\"$PNAME\",\"sinceOffset\":\"-00:00:01\"}}"
  echo "  Hasura whole profile (UI GetProfileSince): $(time_gql "$WHOLE") raw, $(time_gql "$WHOLE" -H 'accept-encoding: gzip') gzip"

  for W in "${WINDOWS[@]}"; do
    # Viewport centred in the profile, plus the one segment that governs its left edge.
    read -r WSS WES <<< "$(q -F ' ' -c "select ($FIRST + $LAST) / 2 - extract(epoch from interval '$W') / 2,
                                               ($FIRST + $LAST) / 2 + extract(epoch from interval '$W') / 2")"
    WS="make_interval(secs => $WSS)"; WE="make_interval(secs => $WES)"
    BOUNDED="($SEL and start_offset <= $WS order by start_offset desc limit 1)
             union all ($SEL and start_offset > $WS and start_offset < $WE order by start_offset)"
    ROWS=$(q -c "select count(*) from ($BOUNDED) x")
    WSI="$WSS seconds"; WEI="$WES seconds"
    WIN="{\"query\":$(jq -Rs . < profile-window.graphql),\"variables\":{\"datasetId\":$DS,\"profileId\":$PID,\"start\":\"$WSI\",\"end\":\"$WEI\"}}"
    # The same viewport for the 10 largest profiles (a timeline with 10 resource rows), one statement.
    MULTI="select x.* from unnest(array[$TOPIDS]) pid, lateral (
             (select start_offset, dynamics, is_gap from merlin.profile_segment where dataset_id = $DS and profile_id = pid
                and start_offset <= $WS order by start_offset desc limit 1)
             union all (select start_offset, dynamics, is_gap from merlin.profile_segment where dataset_id = $DS and profile_id = pid
                and start_offset > $WS and start_offset < $WE order by start_offset)) x"
    MROWS=$(q -c "select count(*) from ($MULTI) y")
    echo "  window $W, 10 largest profiles: $MROWS segments; SQL $(time_sql "$MULTI") ms"
    echo "  window $W: $ROWS segments; SQL $(time_sql "$BOUNDED") ms; Hasura $(time_gql "$WIN") raw, $(time_gql "$WIN" -H 'accept-encoding: gzip') gzip"
  done
done
