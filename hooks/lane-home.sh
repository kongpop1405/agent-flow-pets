#!/usr/bin/env bash
# Live view of the lane-home dispatcher's qwen runs and the gate-runner, for the pane.
# The dispatcher and its qwen sessions run outside this Claude session, so no hook ever
# sees them: their pid files are the only record of what is running now.
#   A <issue> <kind> <started-epoch> <try> <title>   a run whose pid is alive
#   E <issue> <try> <exit>                            an end line the dispatcher logged
# <try> = how many times the dispatcher has picked that issue, counted over the whole log:
# a retry gets its own node in the pane, so the failed try stays visible.
#   G <pid> <started-epoch> <last log line>     the gate-runner holding its lock
RUN="${LANE_HOME_RUN:-$HOME/.lane-home-run}"
cd "$RUN" 2>/dev/null || exit 0
LOG=dispatch.log

for f in issue-*.pid issue-*.msyspid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
  base=${f#issue-}
  n=${base%%.*}
  rest=${base#*.}
  # issue-42.code.pid → code · issue-20.msyspid → manual (a hand-launched run)
  case "$rest" in pid|msyspid) kind=manual ;; *) kind=${rest%%.*} ;; esac
  title=$(grep -a "หยิบ #$n " "$LOG" 2>/dev/null | tail -1 | sed -E 's/^[0-9:]+ หยิบ #[0-9]+ \([a-z]+\) //')
  try=$(grep -ac "หยิบ #$n " "$LOG" 2>/dev/null)
  printf 'A\t%s\t%s\t%s\t%s\t%s\n' "$n" "$kind" "$(stat -c %Y "$f")" "${try:-1}" "$title"
done

# end lines read "จบ #n (kind) ok", "... exit N", or a reason (timeout, silent end, gateway): only ok is a clean exit
# the k-th end line of an issue closes its k-th pick (one run per issue at a time)
awk '
  / หยิบ #[0-9]+ \(/ { s = $0; sub(/^.* หยิบ #/, "", s); sub(/ .*$/, "", s); pick[s]++ }
  / จบ #[0-9]+ \(/ {
    s = $0; sub(/^.* จบ #/, "", s); n = s; sub(/ .*$/, "", n); end[n]++
    rest = s; sub(/^[0-9]+ \([a-z]+\) /, "", rest)
    if (rest == "ok") code = 0
    else if (rest ~ /^exit [0-9]+/) { code = rest; sub(/^exit /, "", code); sub(/[^0-9].*$/, "", code) }
    else code = 1
    printf "E\t%s\t%d\t%s\n", n, end[n], code
  }' "$LOG" 2>/dev/null

# gate-runner writes a Windows pid (node), which kill -0 in MSYS cannot see: ask ps -W.
if [ -f gate-runner.lock/pid ]; then
  gp=$(cat gate-runner.lock/pid 2>/dev/null)
  if [ -n "$gp" ] && ps -W | awk -v p="$gp" '$4 == p { f = 1 } END { exit !f }'; then
    last=$(grep -a '#' gate-runner.log 2>/dev/null | tail -1 | cut -c1-120)
    printf 'G\t%s\t%s\t%s\n' "$gp" "$(stat -c %Y gate-runner.lock/pid)" "$last"
  fi
fi
exit 0
