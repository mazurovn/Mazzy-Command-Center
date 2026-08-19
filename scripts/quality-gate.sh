#!/usr/bin/env bash
# quality-gate.sh — publication safety gate for the public repository.
#
# Fails (non-zero) if anything that must NOT be published is present: secrets,
# host paths, runtime/work artifacts, databases, session logs, or internal
# process notes. Run before every push. It scans the tracked working tree only.
#
# Usage: bash scripts/quality-gate.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FAIL=0
red(){ printf '\033[1;31m[BLOCK]\033[0m %s\n' "$*"; FAIL=1; }
ok(){  printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# The set of files that would actually be committed/pushed (respects .gitignore).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mapfile -t FILES < <(git ls-files)
else
  mapfile -t FILES < <(find . -type f -not -path './node_modules/*' -not -path './.git/*')
fi
# Exclude this gate script itself from content scans (it names the patterns).
scan_files(){ printf '%s\n' "${FILES[@]}" | grep -vE '^scripts/quality-gate\.sh$'; }

echo "== 1. Forbidden files (runtime / work / secrets) =="
FORBIDDEN='(^|/)(\.mazzy|\.pi|\.pi-ops|\.env)(/|$)|\.(db|db-.*|jsonl|log|tsbuildinfo)$|(^|/)node_modules/|(^|/)dist/|(^|/)coverage/'
if scan_files | grep -Eq "$FORBIDDEN"; then
  red "runtime/work/secret files are tracked:"; scan_files | grep -E "$FORBIDDEN" | sed 's/^/        /'
else ok "no runtime/work/secret files tracked"; fi

echo "== 2. Host paths / personal identifiers =="
# Real user home paths must never appear; /home/example is the sanctioned fixture.
if scan_files | xargs grep -lnE '/home/(mazurov|[a-z]+)/(RESEARCH|Desktop|Downloads)|/Users/[a-z]+/' 2>/dev/null | grep -q .; then
  red "host paths found:"; scan_files | xargs grep -nE '/home/(mazurov|[a-z]+)/(RESEARCH|Desktop|Downloads)|/Users/[a-z]+/' 2>/dev/null | grep -vE '/home/example' | sed 's/^/        /'
else ok "no personal host paths"; fi
# Allowed author attribution: the GitHub profile/repo URL (github.com/mazurovn)
# and the author name "Mazurov N.N.". A personal email is never allowed.
if scan_files | xargs grep -nE '@(gmail|yandex|mail\.ru|outlook|proton)\.' 2>/dev/null | grep -q .; then
  red "personal email found:"; scan_files | xargs grep -nE '@(gmail|yandex|mail\.ru|outlook|proton)\.' 2>/dev/null | sed 's/^/        /'
else ok "no personal emails"; fi
# A bare 'mazurov' that is NOT a sanctioned occurrence is suspicious. Sanctioned:
# the GitHub URL, the author name, and the npm scope '@mazurovn/'.
SANCTIONED='github\.com/mazurovn|Mazurov N\.N\.|@mazurovn/'
if scan_files | xargs grep -nE 'mazurov' 2>/dev/null | grep -viE "$SANCTIONED" | grep -q .; then
  red "unexpected 'mazurov' occurrence (not a sanctioned attribution):"; scan_files | xargs grep -nE 'mazurov' 2>/dev/null | grep -viE "$SANCTIONED" | sed 's/^/        /'
else ok "only sanctioned author/scope (Mazurov N.N. / github.com/mazurovn / @mazurovn)"; fi

echo "== 3. Secrets / credentials =="
SECRET='(ghp_[A-Za-z0-9]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN[A-Z ]+PRIVATE KEY-----|(api[_-]?key|secret|password|passwd)\s*[:=]\s*["'"'"'][A-Za-z0-9_+/=-]{12,}["'"'"'])'
if scan_files | xargs grep -lnEi "$SECRET" 2>/dev/null | grep -q .; then
  red "possible secret literal:"; scan_files | xargs grep -nEi "$SECRET" 2>/dev/null | sed 's/^/        /'
else ok "no secret literals"; fi

echo "== 4. Internal process notes (consilium / red-team / model names) =="
INTERNAL='consilium|red-team|adversarial|\bopus ?5\b|\bfable\b|/Sol/|BLOCKER|CRITICAL F-1|round-2 finding|\.mazzy/audits'
if scan_files | grep -vE '\.(md)$' | xargs grep -lnEi "$INTERNAL" 2>/dev/null | grep -q .; then
  red "internal process note in code:"; scan_files | grep -vE '\.(md)$' | xargs grep -nEi "$INTERNAL" 2>/dev/null | grep -viE 'resolve|absol|console|resolut|solid' | sed 's/^/        /'
else ok "no internal process notes in code"; fi

echo "== 5. Only allowed top-level entries =="
ALLOWED='^(src|static|skills|resources|test|docs|scripts|README\.md|LICENSE|package\.json|package-lock\.json|tsconfig\.json|\.npmignore|\.gitignore|\.gitattributes)(/|$)'
BAD=$(scan_files | grep -oE '^[^/]+(/|$)' | sort -u | grep -vE "$ALLOWED" || true)
if [ -n "$BAD" ]; then red "unexpected top-level entries:"; printf '%s\n' "$BAD" | sed 's/^/        /'; else ok "only allowed top-level entries"; fi

echo "== 6. Required public files present =="
for f in README.md LICENSE package.json docs/ARCHITECTURE.md; do
  [ -e "$f" ] && ok "present: $f" || red "missing required public file: $f"
done

echo "== 7. package.json references no unpublished file =="
if grep -qE 'RELEASE_METADATA_GATE|\.mazzy' package.json 2>/dev/null; then
  red "package.json references an unpublished artifact"; else ok "package.json is clean"; fi

echo
if [ "$FAIL" -ne 0 ]; then printf '\033[1;31mQUALITY GATE FAILED — do not push.\033[0m\n'; exit 1; fi
printf '\033[1;32mQUALITY GATE PASSED — safe to publish.\033[0m\n'
