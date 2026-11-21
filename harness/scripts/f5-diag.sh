#!/bin/sh
# F5 diagnostic, run inside etr-besu4: does Besu's JVM load libfaketime, and with which environment?
echo "shell date (UTC): $(date -u +%H:%M:%S)"
for d in /proc/[0-9]*; do
  c=$(cat "$d/comm" 2>/dev/null)
  [ "$c" = "java" ] || continue
  exe=$(readlink "$d/exe")
  echo "java pid: ${d#/proc/}   exe: $exe"
  "$exe" -version 2>&1 | head -2
  echo "libfaketime mapped in the JVM: $(grep -c faketime "$d/maps") lines"
  echo "JVM environment:"
  tr '\000' '\n' < "$d/environ" | grep -E 'LD_PRELOAD|FAKETIME|JAVA_OPTS|BESU_OPTS'
done
echo "--- all processes (pid, name, command line) ---"
for d in /proc/[0-9]*; do
  [ -r "$d/cmdline" ] || continue
  echo "${d#/proc/}  $(cat "$d/comm" 2>/dev/null)  $(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-150)"
done
echo "--- /etc/ld.so.preload ---"; cat /etc/ld.so.preload 2>/dev/null
