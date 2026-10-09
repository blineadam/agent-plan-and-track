# Live-Run Egress Proxy

Working recipe for the allowlisting forward proxy [[skill-activation]]'s
Phase 2 points sandboxed `--run` cases at. See that SKILL.md for when to use
it; this file is the mechanics.

## Contents

Topics, in order:

- Squid build requirement and the throwaway `tls-cert=` file
- Why `generate-host-certificates=off` is required
- The `squid.conf` allowlist (CONNECT and SNI ACLs, peek-and-splice)
- Denying all other egress at the network layer, and what the allowlist cannot see
- Docker Desktop on macOS: build, prove the wall, run, tear down
- Allowing the npm registry for cases that install packages

Enforcing the allowlist by TLS SNI, not by the CONNECT line's hostname, needs
Squid built against OpenSSL: Debian and Ubuntu's default `squid` package is
built against GnuTLS and refuses this config, so install
[`squid-openssl`](https://packages.debian.org/bookworm/squid-openssl) instead
(it conflicts with, and replaces, `squid`). The `tls-cert=` file below is a
throwaway self-signed certificate that the port requires in order to start.
An allowed connection is spliced end to end and never sees it. A denied one
does: Squid presents this certificate instead of the real host's and the
client rejects the handshake, which is the intended outcome and the reason
the subject on it does not matter.

Generate that certificate before starting Squid, or the port fails at
startup:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=unused" -keyout /etc/squid/dummy.pem -out /etc/squid/dummy.pem
chown proxy:proxy /etc/squid/dummy.pem && chmod 600 /etc/squid/dummy.pem
```

Cert and key share one file because Squid assumes the `tls-cert=` file also
carries the key when no `tls-key=` is given. The subject is irrelevant.

The `generate-host-certificates=off` on the port below is a startup
requirement, not tidiness. That option defaults to on whenever ssl-bump is
used, and Squid starts the certificate generation helper on that default
alone, before any `ssl_bump` rule runs. The helper immediately dies because
its database was never created, and on Squid 5.7 with squid-openssl on Debian
bookworm startup fails with "FATAL: The sslcrtd_program helpers are crashing
too rapidly, need help!"

Turning the option off stops the helper from starting at all, which is what
this ruleset wants anyway. Left on, Squid mints a certificate for the denied
hostname when it refuses a connection, so the signing machinery runs even
though nothing here is ever bumped on purpose. Creating the database instead
also clears the startup failure, but it does so by giving that machinery what
it needs rather than by switching it off.

```squid
# squid.conf: destination-allowlisted forward proxy for billable live runs.
# Host list: https://code.claude.com/docs/en/network-config is the source of
# truth. Re-check it; hosts change. Also set
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 in the sandbox so optional
# telemetry never hits the deny wall.

# Bind only the interface the sandbox reaches, never 0.0.0.0: the proxy has
# exactly one legitimate client. Give the sandbox its own user-defined Docker
# network rather than the default bridge (that bridge's /16 is shared by
# every container on the host) and match its single address here, not a CIDR
# range. Both addresses below belong to such a network; substitute the ones
# your own network hands out.
#
# ssl-bump plus tls-cert is required by the parser to start this port at all.
# generate-host-certificates=off keeps Squid from starting the certificate
# generation helper it would otherwise start by default under ssl-bump; see
# the startup note above this config block.
# Never change splice to bump below: that would MITM provider traffic and
# expose the credential and every prompt to the proxy.
http_port 172.20.0.1:3128 ssl-bump tls-cert=/etc/squid/dummy.pem generate-host-certificates=off
acl sandbox src 172.20.0.2/32

# api.anthropic.com carries inference. platform.claude.com carries OAuth token
# refresh for claude.ai accounts, so a long corpus dies mid-run without it;
# drop it from both lines only if the sandbox authenticates with an API key.
#
# Two ACLs on purpose. The CONNECT line decides which names Squid will even
# resolve and dial; the SNI check below decides what the TLS session may then
# ask for. Keep both: on SNI alone, a crafted CONNECT hostname reaches the
# attacker's own DNS server carrying whatever it encodes, long before the
# handshake that would have been terminated.
#
# -n is load-bearing, not tidiness. Without it, a bare-IP CONNECT that fails
# the name comparison sends Squid off to a reverse PTR lookup, and that record
# belongs to whoever owns the address: an attacker pointing their own PTR at
# an allowed name would pass this ACL and then splice with a matching SNI.
# -n makes that type mismatch an immediate miss and looks nothing up. It does
# not affect resolving an allowed name in order to dial it, which happens
# outside ACL matching. See https://www.squid-cache.org/Doc/config/acl/ for
# the -n option and dstdomain's own matching semantics.
acl provider_host dstdomain -n api.anthropic.com platform.claude.com
acl provider_sni ssl::server_name api.anthropic.com platform.claude.com

# TLS only: no CONNECT tunnel to an arbitrary port on an allowed host.
acl tls_port port 443

# A CONNECT tunnel only tells Squid the hostname the client typed, so peek at
# the real ClientHello SNI instead of trusting that line, terminate anything
# that doesn't match, then splice the rest through unmodified. A spliced
# connection is never decrypted; the client's TLS session runs end to end.
# See https://wiki.squid-cache.org/Features/SslPeekAndSplice for the peek
# and splice mechanism.
acl step1 at_step SslBump1
ssl_bump peek step1
ssl_bump terminate !provider_sni
ssl_bump splice all

http_access allow sandbox provider_host tls_port
http_access deny all

# Pin the proxy's own resolver; don't let the sandbox's resolv.conf pick it.
dns_nameservers 1.1.1.1 9.9.9.9

# The cache holds no content under CONNECT, but the access log does record
# client-supplied hostnames, which is both what makes it useful for audit and
# why it must be treated as sensitive and rotated or scrubbed like any other
# artifact that saw the run.
cache deny all
# Denied and terminated lines are the audit channel: a denied CONNECT is a
# rejected destination and a terminated bump is an SNI mismatch. An allowed
# line only records the hostname the client asked for, so it can be a
# rotated provider host or stray tooling just as easily as an adversary.
access_log stdio:/var/log/squid/access.log
```

Swap the hostnames per that provider's own allowlist doc when a case targets a
different provider.

The proxy is the permitted door, not the wall. Deny all other egress at the
network layer, including port 53: an adversarial case can open raw sockets, and
a CONNECT proxy means the sandbox needs no direct DNS of its own. On the Docker
topology this config assumes, a host `iptables -A OUTPUT` rule does not do that:
container traffic is forwarded rather than host-originated, so it never reaches
that chain, and Docker's own chains take precedence regardless. Use the
[`DOCKER-USER`](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
chain, or an internal user-defined network with the proxy as the sandbox's only
route out, and prove the wall exists with a curl to an unrelated host from
inside the sandbox before spending anything.

The allowlist governs destinations the proxy can observe, and three stay
unobservable by construction. Inside the request body: the mounted credential
lets an injected case ship data out to the provider itself, so the allowlist
contains destinations, not payloads. Inside the tunnel: splicing enforces the
TLS SNI, not the encrypted HTTP Host header, so a frontend serving other
tenants by inner Host on the same address stays reachable in principle. Inside
the ClientHello: the SNI check reads that name in the clear, so an encrypted
ClientHello would move the real destination out of view entirely. The last two
are the frontend operator's control rather than this config's, and today
`dig HTTPS api.anthropic.com` advertises no `ech=` parameter; re-check that
rather than assume it.

## Docker Desktop on macOS

The `DOCKER-USER` chain lives inside Docker Desktop's VM, so the
internal-network route is the practical one on a Mac. The steps below ran end
to end, with paid behavioral `--run`s, on Docker Desktop 4.94 (engine 29.8)
on Apple silicon. Run them from any directory outside the repo; each block
assumes the variables from the first.

### 1. Build the proxy and sandbox images

```bash
REPO=/path/to/checkout              # the working tree under test
TOKEN_FILE=/path/to/token-file      # holds the OAuth token and nothing else
PT=$(mktemp -d)                     # build contexts and copied-out results
mkdir -p "$PT/proxy" "$PT/sandbox"

# The squid.conf block above, verbatim. For cases that run npm, apply the
# sed from "Allowing the npm registry" right after this awk, before the build.
awk '/^```squid$/{f=1;next} /^```$/{f=0} f' \
    "$REPO/skills/skill-activation/references/live-run-egress-proxy.md" \
    > "$PT/proxy/squid.conf"

cat > "$PT/proxy/Dockerfile" <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid-openssl openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
RUN openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=unused" \
      -keyout /etc/squid/dummy.pem -out /etc/squid/dummy.pem \
    && chown proxy:proxy /etc/squid/dummy.pem && chmod 600 /etc/squid/dummy.pem
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
EOF

cat > "$PT/sandbox/Dockerfile" <<'EOF'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m -u 1001 runner && mkdir -p /sandbox /work && chown runner /sandbox /work
USER runner
ENV HOME=/sandbox
WORKDIR /work
EOF

docker build -t pt-smoke-proxy "$PT/proxy"
docker build -t pt-smoke-sandbox "$PT/sandbox"
```

The sandbox image needs `jq` because `install.sh` does, and runs as a
non-root `runner` that owns its `HOME` and `/work`, so nothing below needs a
root `exec` or a `chown`.

### 2. Create the internal network and start the proxy

```bash
docker network create --internal --subnet 172.20.0.0/24 \
    --gateway 172.20.0.254 pt-smoke-net
docker create --name pt-smoke-proxy pt-smoke-proxy
docker network connect --ip 172.20.0.1 pt-smoke-net pt-smoke-proxy
docker start pt-smoke-proxy
```

Docker claims a subnet's first address as its gateway unless told otherwise,
so without `--gateway` the attach at 172.20.0.1 fails with "Address already
in use". If the subnet overlaps a network you already have, pick another and
change both addresses in `squid.conf` to match.

The proxy is created on the default bridge, which is its own route out, and
attached to the internal network before it starts: Squid binds its
`http_port` address at startup, so attaching after `docker start` is a race.
The sandbox joins only the internal network, so the proxy is its sole route
out.

### 3. Start the sandbox with the credential

```bash
P=http://172.20.0.1:3128
CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" docker run -d --name ptbox \
    --network pt-smoke-net --ip 172.20.0.2 --dns 127.0.0.1 \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -e HTTPS_PROXY=$P -e HTTP_PROXY=$P -e https_proxy=$P -e http_proxy=$P \
    -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
    -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    pt-smoke-sandbox sleep infinity
```

The token is passed by name, so its value never appears in an argument list.
`--dns 127.0.0.1` leaves the sandbox no resolver of its own, which the
CONNECT proxy does not need. `NO_PROXY` keeps loopback traffic off the proxy:
without it, a case that starts a stub server and curls it on localhost gets a
403 from Squid and spends its turns debugging that instead of the task.

### 4. Prove the wall before spending

```bash
docker exec ptbox curl -sS -o /dev/null -m 20 -w '%{http_code}\n' https://api.anthropic.com/     # 404
docker exec ptbox curl -sS -k -o /dev/null -m 20 -w '%{http_code}\n' https://example.com/         # 403
docker exec ptbox env -u HTTPS_PROXY -u https_proxy curl -sS -m 10 https://1.1.1.1/; echo rc=$?    # rc=7
docker exec ptbox getent hosts example.com; echo rc=$?                                             # rc=2
docker exec ptbox sh -c 'node -e "require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(8080)" & s=$!
    sleep 1; curl -sS -m 5 http://localhost:8080/; echo; kill $s'                                  # ok
```

The 404 is the provider answering through the splice, the 403 is Squid
refusing an unlisted destination, `rc=7` is a direct connection with no route
out, `rc=2` is the missing resolver, and `ok` is loopback bypassing the proxy.
Any other result means the wall is not the one this doc describes: stop and
fix it before a paid run.

### 5. Copy the tree in and install

```bash
git -C "$REPO" ls-files -z --cached --others --exclude-standard \
    | (cd "$REPO" && tar -c --no-mac-metadata --null -T - -f -) \
    | docker exec -i ptbox tar -x -C /work
docker exec -e PT_BYPASS_PERMISSIONS=1 ptbox ./install.sh claude
```

This copies the working tree as git sees it, uncommitted edits and new
untracked files included. It carries the fixtures' tracked `.tasks/`
directories, which any copy that filters out `.tasks` would drop, and leaves
behind the host's own ignored scratch and the `.git` entry: in a linked
worktree that entry is a file pointing at a host path, and under a dangling
pointer git refuses even `git config --global`, so `install.sh`'s global
excludes step fails "not a git repository". `tar` stops on a tracked file
deleted from the working tree, so commit or restore deletions first.

To compare against a base revision, install it into a second `HOME`; the arm
is chosen by `HOME` alone, which decides which skill bodies `claude` loads,
while both arms run the corpus and runner from `/work`:

```bash
docker exec ptbox mkdir -p /sandbox/base-src /sandbox/base
git -C "$REPO" archive main | docker exec -i ptbox tar -x -C /sandbox/base-src
docker exec -w /sandbox/base-src -e HOME=/sandbox/base -e PT_BYPASS_PERMISSIONS=1 ptbox ./install.sh claude
```

### 6. Run a subset, copy the results out, score

```bash
IDS='logging-practices-service-logging|logging-practices-thin-wrapper'   # grep -E alternation of case ids
FX=/work/skills/skill-activation/fixtures
SC=/work/skills/skill-activation/scripts
docker exec ptbox sh -c "jq -c --arg re '^($IDS)\$' 'select(.id|test(\$re))' \
    $FX/behavioral-cases.jsonl > $FX/subset.jsonl && wc -l < $FX/subset.jsonl"   # one line per id
docker exec ptbox node $SC/run-behavioral-smokes.js --dry-run $FX/subset.jsonl

# Billable. Add -e HOME=/sandbox/base for the base arm, with its own results dir.
docker exec -e ACTIVATION_ALLOW_SPEND=1 ptbox \
    node $SC/run-behavioral-smokes.js --run /tmp/res-new $FX/subset.jsonl

docker cp ptbox:/tmp/res-new "$PT/res-new"
docker cp ptbox:$FX/subset.jsonl "$PT/subset.jsonl"
node "$REPO/skills/skill-activation/scripts/run-behavioral-smokes.js" --check "$PT/res-new" "$PT/subset.jsonl"
```

The subset must sit in the fixtures directory, since the runner resolves
fixture dirs relative to the corpus file, but `--check` reads only the corpus
and the results directory, so the copied-out subset works from anywhere.
Results are written inside the container and copied out afterward: the runner
writing straight into a directory bind-mounted from macOS failed with
`EACCES` before any case spawned. Each `--run` needs a results directory that
does not exist yet. A case takes from under a minute to about eight, so a
shell with a shorter command timeout should background the `--run`;
`LIVE_CASE_TIMEOUT_MS` caps each case at 900000 by default. `--check`, like the runner, exits 1 when any case fails or
scores invalid, so a non-zero exit there is a verdict, not a broken pipeline.

### 7. Tear down

```bash
docker rm -f ptbox pt-smoke-proxy && docker network rm pt-smoke-net
```

The proxy's access log records every hostname the run asked for and goes
with its container; copy it out first with
`docker cp pt-smoke-proxy:/var/log/squid/access.log "$PT/"` if you want the
audit trail. To pick up an edited tree, recreate only `ptbox` (steps 3 to 5)
and leave the proxy and network up.

## Allowing the npm registry for cases that install packages

The logging-practices smokes ask for a service whose right answer is a
logging library, so with the model API as the only allowed host, `npm
install` fails and the run measures the agent coping with that instead of
the skill. For those runs, add `registry.npmjs.org` to both allowlist lines
in step 1, between the `awk` extraction and the `docker build`:

```bash
sed -i '' -E '/^acl provider_(host|sni) /s/$/ registry.npmjs.org/' "$PT/proxy/squid.conf"
grep '^acl provider_' "$PT/proxy/squid.conf"    # both lines now end in registry.npmjs.org
```

That is the macOS `sed -i ''` form; GNU sed takes `-i` alone. Both lines need
the name, for the same reason both ACLs exist. Every allowed host is one more
place an injected case can send data, and a package registry also hands it
code to run, so splice it in only for the runs that need it. Rebuilding the
image afterward is not enough on its own, since the running proxy keeps the
config it started with: rerun step 1's `awk` and proxy `docker build`, then
`docker rm -f pt-smoke-proxy` and repeat step 2's `docker create`, `docker
network connect`, and `docker start` (the network itself can stay).
