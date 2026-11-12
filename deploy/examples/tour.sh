#!/usr/bin/env bash
# SPDX-License-Identifier: Elastic-2.0
# SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

# The five minute trust tour (docs: TOUR.md).
#
# Three claims, each shown rather than asserted:
#
#   1. personal data is tokenised BEFORE a model sees it, and the real value is
#      back in the answer the caller receives;
#   2. a tool that needs a person stops until that person answers, and an
#      unanswered request is a REJECTION, not a slow approval;
#   3. the decision is written down as a signed receipt that verifies offline —
#      and stops verifying the moment one byte of it is changed.
#
# It runs against the quickstart stack in this directory and needs nothing but
# curl and bun on the host. Every step prints what it is about to look at before
# it looks, so you can follow along instead of trusting the colours at the end.
#
# Written to be read top to bottom: one section per claim, no cleverness.

# The single-quoted blocks below are JavaScript, not shell: shellcheck must not
# read the `${…}` inside them as missing shell expansion.
# shellcheck disable=SC2016

set -euo pipefail

usage() {
	cat <<'EOF'
usage: tour.sh [--runtime URL] [--approval-window MS] [--keep] [--help]

  --runtime URL         Runtime base URL.
                        Default: http://127.0.0.1:$ATF_RUNTIME_PORT (or 3000).
  --approval-window MS  The APPROVAL_TIMEOUT_MS the stack was started with.
                        Default: $ATF_APPROVAL_TIMEOUT_MS (or 15000). The tour
                        demonstrates a request nobody answers, so a stack still
                        on the 600 s demo default would just look like a hang -
                        start it as TOUR.md step 0 shows:
                          ATF_APPROVAL_TIMEOUT_MS=15000 docker compose up -d
  --keep                Leave the downloaded receipts, traces and the tampered
                        copy in place and print where they are.

exit codes: 0 everything demonstrated, 1 a step did not behave as documented,
2 the tour was called wrongly or the stack is not reachable.
EOF
}

runtime="${ATF_TOUR_RUNTIME:-http://127.0.0.1:${ATF_RUNTIME_PORT:-3000}}"
approval_window="${ATF_APPROVAL_TIMEOUT_MS:-15000}"
keep="no"

while [[ $# -gt 0 ]]; do
	case "$1" in
	--runtime)
		[[ $# -ge 2 ]] || {
			echo "--runtime needs a value" >&2
			exit 2
		}
		runtime="$2"
		shift 2
		;;
	--approval-window)
		[[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || {
			echo "--approval-window needs a number of milliseconds" >&2
			exit 2
		}
		approval_window="$2"
		shift 2
		;;
	--keep)
		keep="yes"
		shift
		;;
--help | -h)
		usage
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done
runtime="${runtime%/}"

if [[ -t 1 ]]; then
	bold=$'\033[1m'
	plain=$'\033[0m'
else
	bold=""
	plain=""
fi

step() { printf '\n%s%s%s\n' "$bold" "$1" "$plain"; }
say() { printf '  %s\n' "$1"; }

# One place for every way a step can go wrong, so a failure always says both
# what was expected and what to do about it.
fail() {
	printf '\n\033[31mnot demonstrated:\033[0m %s\n' "$1" >&2
	printf '  %s\n' "$2" >&2
	exit 1
}

outdir="$(mktemp -d)"
[[ "$keep" == "yes" ]] || trap 'rm -rf "$outdir"' EXIT

for bin in curl bun; do
	command -v "$bin" >/dev/null 2>&1 || {
		echo "tour.sh needs $bin on PATH." >&2
		exit 2
	}
done

# Read one field out of a downloaded JSON file. Bun is already required for the
# offline verification in step 3, so it is also the JSON reader - the tour must
# not need a second toolchain.
jq_field() { # <file> <javascript expression on the parsed document>
	SRC="$1" EXP="$2" bun -e '
const d = await Bun.file(process.env.SRC).json();
const value = eval(process.env.EXP);
console.log(value === undefined || value === null ? "" : value);
'
}

get() { # <path> <outfile>
	curl -sS --fail --max-time 30 "$runtime$1" -o "$2"
}

post_chat() { # <model/flow> <message> <headers out> <body out>
	# The message is escaped by bun rather than written into the -d literal, so a
	# quote or a newline in demo text cannot break the JSON body.
	escaped="$(printf '%s' "$2" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()));')"
	# A run may sit in the approval gate for the whole window before it answers,
	# so the request timeout has to outlast it - a fixed two minutes would cut
	# the connection of step 2b on a stack that still runs the 600 s default.
	curl -sS --fail --max-time "$((120 + approval_window / 1000))" -D "$3" -o "$4" \
		-X POST "$runtime/v1/chat/completions" \
		-H 'content-type: application/json' \
		-d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":$escaped}]}"
}

header_value() { # <headers file> <header name>
	tr -d '\r' <"$1" | awk -v h="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" '{ if (tolower($1) == h ":") { print $2; exit } }'
}

# The message used in step 1. Written to be one sentence a real caller would
# write, because the detectors have to fire on ordinary text, not on a fixture.
PII_TEXT='Please forward my invoice to maria.huber@example.com and pay it to DE89370400440532013000 by Friday.'

# ---------------------------------------------------------------------------
# Step 0 — is the stack configured the way the tour assumes?
# ---------------------------------------------------------------------------

step "0. checking the stack at $runtime"

curl -sS --fail --max-time 10 "$runtime/health" -o "$outdir/health.json" || {
	echo "the Runtime does not answer at $runtime/health." >&2
	echo "Start the quickstart first (see TOUR.md step 0):" >&2
	echo "  cd $(cd "$(dirname "$0")" && pwd) && docker compose --env-file .env.example -f compose.yaml up -d" >&2
	exit 2
}

# Governance posture is one call that reports every control the tour leans on,
# by name, with the environment variable to fix it. Reading it beats discovering
# a missing switch halfway through a demo.
get /monitoring/posture "$outdir/posture.json"
while read -r name status message; do
	if [[ "$status" == "ok" ]]; then
		say "$name — ok"
	else
		fail "$name is not active" "$message"
	fi
done < <(SRC="$outdir/posture.json" bun -e '
const d = await Bun.file(process.env.SRC).json();
for (const id of ["pii_vault", "approval_gate", "receipts"]) {
  const check = d.checks.find((c) => c.id === id);
  if (check) console.log([check.id, check.status, check.message].join(" "));
}
')

# ---------------------------------------------------------------------------
# Step 1 — what the model was given, and what the caller got back
# ---------------------------------------------------------------------------

step "1. tokenisation: the model must not see the address, the caller must"

say "sending one message that contains an e-mail address and an IBAN to flow model-echo"
say "the flow pins the mock's echo model: it answers with the messages it was given,"
say "so its reply is a report of its own input rather than an opinion about it."

post_chat model-echo "$PII_TEXT" "$outdir/echo.heads" "$outdir/echo.json"
execution_id="$(header_value "$outdir/echo.heads" X-Execution-Id)"
[[ -n "$execution_id" ]] || fail "no X-Execution-Id header came back" "the tour needs it to fetch the sealed Debug_Trace for this run."

# The Debug_Trace is what the Runtime recorded for the model call: the prompt it
# assembled and the reply it got. It is the only place the tour can read the
# model's own view of the conversation.
get "/monitoring/debug/$execution_id" "$outdir/trace.json"

grep -q '\[\[PII:' "$outdir/trace.json" ||
	fail "no placeholder in the Debug_Trace" "the prompt recorded for $execution_id contains no [[PII:...]] token, so nothing was tokenised before the model call."
if grep -q 'maria\.huber@example\.com' "$outdir/trace.json"; then
	fail "the e-mail address is in what the model was given" "the Debug_Trace for $execution_id still carries the cleartext address: tokenisation did not run."
fi
if grep -q 'DE89370400440532013000' "$outdir/trace.json"; then
	fail "the IBAN is in what the model was given" "the Debug_Trace for $execution_id still carries the cleartext IBAN."
fi
grep -q 'maria\.huber@example\.com' "$outdir/echo.json" ||
	fail "the caller did not get the real address back" "the answer should carry the cleartext value again - re-substitution did not happen, or the vault is misconfigured."

say "what the model was given:"
SRC="$outdir/trace.json" bun -e '
const d = await Bun.file(process.env.SRC).json();
for (const m of d.input_messages ?? []) {
  const line = `${m.role}: ${m.content}`;
  console.log("    " + (line.length > 150 ? line.slice(0, 150) + " …" : line));
}
'
say "what the caller got back:"
SRC="$outdir/echo.json" bun -e '
const doc = await Bun.file(process.env.SRC).json();
const text = doc.choices?.[0]?.message?.content ?? "";
console.log(text.split("\n").slice(0, 12).map((l) => "    " + l).join("\n"));
'
say "same conversation, two different texts: the model saw tokens, you got your data back."

# ---------------------------------------------------------------------------
# Step 2 — a person in the loop, both ways round
# ---------------------------------------------------------------------------

step "2. approval: one call answered, one call left unanswered"
say "flow tool-use-with-approval ends in a tool node whose tool is listed in"
say "APPROVAL_REQUIRE_TOOLS, so the run stops there and waits."

# Both halves below look for an approval this run created, by comparing against the ids that
# already existed. Without that, a second run of the tour would find the first run's expired
# request and report success without the new request ever having timed out - and a leftover
# pending request would be approved instead of the fresh one.
get "/monitoring/approvals" "$outdir/before.json"
TOUR_SEEN_IDS="$(jq_field "$outdir/before.json" "JSON.stringify([...(d.resolved ?? []), ...(d.pending ?? [])].map((a) => a.id))")"
export TOUR_SEEN_IDS
new_approval() { # <list file> <resolved|pending> <extra javascript predicate>
	jq_field "$1" "(d.$2 ?? []).find((a) =>
		!JSON.parse(process.env.TOUR_SEEN_IDS).includes(a.id)$3)?.id ?? ''"
}

say "2a. triggering the call that will be approved"
post_chat tool-use-with-approval "My invoice PDF will not upload, please help." \
	"$outdir/approved.heads" "$outdir/approved.json" &
approved_pid=$!

approval_id=""
deadline=$((SECONDS + 30))
while [[ $SECONDS -lt $deadline ]]; do
	get "/monitoring/approvals?status=pending" "$outdir/pending.json" 2>/dev/null || true
	approval_id="$(new_approval "$outdir/pending.json" pending "")"
	[[ "$approval_id" != "{}" && -n "$approval_id" ]] && break
	approval_id=""
	sleep 1
done
[[ -n "$approval_id" ]] || {
	wait "$approved_pid" 2>/dev/null || true
	fail "no pending approval appeared" "the flow ran straight through, so APPROVAL_REQUIRE_TOOLS is not covering gate/ticket_create - check the runtime environment."
}
say "    the run is parked: approval $approval_id asks to run gate/ticket_create"

get "/monitoring/approvals?status=pending" "$outdir/pending.json"
say "    with the arguments as the flow declared them:"
TOUR_ID="$approval_id" SRC="$outdir/pending.json" bun -e 'const doc = await Bun.file(process.env.SRC).json();
const a = (doc.pending ?? []).find((x) => x.id === process.env.TOUR_ID);
console.log("      " + JSON.stringify(a?.args));
'

curl -sS --fail --max-time 30 -X POST "$runtime/monitoring/approvals/$approval_id" \
	-H 'content-type: application/json' \
	-d '{"approved":true,"by":"tour.sh"}' -o "$outdir/decision.json"
say "    answered: approved as tour.sh"
wait "$approved_pid" ||
	fail "the approved run did not finish cleanly" "the Runtime closed the request with an error after the decision was posted - look at the flow's tool node (\$ docker compose logs runtime)."

get "/monitoring/approvals" "$outdir/resolved.json"
jq_field "$outdir/resolved.json" "d.resolved?.find(a=>a.id===\"$approval_id\")?.approved" | grep -q '^true$' ||
	fail "the approved call did not finish as approved" "approval $approval_id is not recorded as approved in the resolved list."
say "    recorded as approved — the run continued and answered."

# The other half of the rule. Silence must never turn into an action, which is
# why the default window is generous for humans and why this step shortens it.
say "2b. triggering the call nobody will answer; waiting ${approval_window} ms"
post_chat tool-use-with-approval "Please cancel my subscription and refund the last month." \
	"$outdir/expired.heads" "$outdir/expired.json" &
expired_pid=$!

expired_id=""
deadline=$((SECONDS + approval_window / 1000 + 20))
while [[ $SECONDS -lt $deadline ]]; do
	get "/monitoring/approvals" "$outdir/resolved2.json"
	expired_id="$(new_approval "$outdir/resolved2.json" resolved " && a.timedOut === true")"
	[[ "$expired_id" != "{}" && -n "$expired_id" ]] && break
	expired_id=""
	sleep 1
done
[[ -n "$expired_id" ]] || {
	wait "$expired_pid" 2>/dev/null || true
	fail "the unanswered request did not expire within $((approval_window / 1000 + 20)) s" \
		"the stack is probably still on the 600 s demo default. Restart it with a short window and pass the same value here:
	    ATF_APPROVAL_TIMEOUT_MS=$approval_window docker compose --env-file .env.example -f compose.yaml up -d
	    ./tour.sh --approval-window $approval_window"
}

wait "$expired_pid" ||
	fail "the unanswered run did not finish cleanly" "the Runtime closed the request with an error when the window closed, instead of answering without the tool - check the runtime logs."
say "    $(TOUR_ID="$expired_id" SRC="$outdir/resolved2.json" bun -e 'const doc = await Bun.file(process.env.SRC).json();
const a = (doc.resolved ?? []).find((x) => x.id === process.env.TOUR_ID);
console.log(`gate/ticket_create resolved as approved=${a.approved}, timedOut=${a.timedOut} after the window closed`);
')"
say "    silence was a rejection: the tool never ran."

# ---------------------------------------------------------------------------
# Step 3 — a receipt you can check without trusting this server
# ---------------------------------------------------------------------------

step "3. receipts: signed, offline-verifiable, and tamper-evident"

say "reading the decision receipt for step 1's execution off the X-ATF-Receipt header"
receipt_id="$(header_value "$outdir/echo.heads" X-ATF-Receipt)"
[[ -n "$receipt_id" ]] || fail "no X-ATF-Receipt header came back" "step 1's run carries no receipt id; DECISION_RECEIPTS_ENABLED must be true."

get "/v1/receipts/$receipt_id" "$outdir/receipt.json"
# The verification key is published so anyone can check a receipt without access
# to the server that issued it. Saved to a file here on purpose: the check below
# never touches the network.
get "/.well-known/atf-receipt-jwks.json" "$outdir/jwks.json"

say "the receipt states which personal data was tokenised, without repeating it:"
SRC="$outdir/receipt.json" bun -e '
const doc = await Bun.file(process.env.SRC).json();
console.log("      " + JSON.stringify(doc.payload.pii));
'

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
verify_script="$repo_root/scripts/atf-verify.ts"
[[ -f "$verify_script" ]] || {
	echo "the offline check needs scripts/atf-verify.ts, which is not under $repo_root." >&2
	echo "Run the tour from a source checkout, or drop the standalone atf-verify binary" >&2
	echo "from the release next to it and re-run with that directory as the repository." >&2
	exit 2
}
verify() { # <receipt file>
	bun "$verify_script" --receipt "$1" --jwks "$outdir/jwks.json" >"$outdir/verify.log" 2>&1
}

set +e
verify "$outdir/receipt.json"
clean_rc=$?
set -e
[[ $clean_rc -eq 0 ]] || fail "atf-verify rejected a genuine receipt (exit $clean_rc)" "last lines: $(tail -3 "$outdir/verify.log" | tr '\n' ' ')"
say "unmodified receipt: atf-verify exits 0 — signature valid, checked against the"
say "published verification key saved in $outdir/jwks.json; no request was sent to do it."

# Tamper with the signed bytes, not the pretty-printed copy next to them: the
# verifier trusts the COSE envelope, so editing `payload` alone proves nothing.
# One byte inside the payload, no re-signing.
SRC="$outdir/receipt.json" DST="$outdir/receipt-tampered.json" bun -e '
const doc = await Bun.file(process.env.SRC).json();
const bytes = Buffer.from(doc.cose_base64, "base64url");
const at = bytes.indexOf(Buffer.from("completed"));
if (at < 0) { console.error("tampering target not found"); process.exit(1); }
bytes[at] = 0x64; // "completed" -> "dompleted": still valid CBOR, different digest
doc.cose_base64 = bytes.toString("base64url");
await Bun.write(process.env.DST, JSON.stringify(doc, null, 2));
'

set +e
verify "$outdir/receipt-tampered.json"
tampered_rc=$?
set -e
[[ $tampered_rc -eq 1 ]] || fail "atf-verify did not reject the tampered receipt (exit $tampered_rc)" "one byte of the signed payload was changed; exit 1 was expected. last lines: $(tail -3 "$outdir/verify.log" | tr '\n' ' ')"
say "receipt with one byte changed: atf-verify exits 1 — $(grep -m1 'signature' "$outdir/verify.log" | sed 's/^ *//')"
say "nothing about this step required trusting the server: the file, the key, and 200 ms of CPU."

step "tour complete"
printf '  three claims shown, not asserted: tokenised before the model, silence is a\n'
printf '  rejection, and a receipt that breaks when you edit it.\n'
if [[ "$keep" == "yes" ]]; then
	printf '  everything the tour fetched is in %s\n' "$outdir"
	trap - EXIT
fi
