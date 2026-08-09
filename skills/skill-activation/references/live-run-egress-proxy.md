# Live-Run Egress Proxy

Working recipe for the allowlisting forward proxy [[skill-activation]]'s
Phase 2 points sandboxed `--run` cases at. See that SKILL.md for when to use
it; this file is the mechanics.

Enforcing the allowlist by TLS SNI, not by the CONNECT line's hostname, needs
Squid built against OpenSSL: Debian and Ubuntu's default `squid` package is
built against GnuTLS and refuses this config, so install
[`squid-openssl`](https://packages.debian.org/bookworm/squid-openssl) instead
(it conflicts with, and replaces, `squid`). The `tls-cert=` file below is a
throwaway self-signed certificate that the port requires to start but never
presents to anything, since this ruleset only peeks and splices, never
decrypts.

Generate that certificate before starting Squid, or the port fails at
startup:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=unused" -keyout /etc/squid/dummy.pem -out /etc/squid/dummy.pem
chown proxy:proxy /etc/squid/dummy.pem && chmod 600 /etc/squid/dummy.pem
```

Cert and key share one file because Squid assumes the `tls-cert=` file also
carries the key when no `tls-key=` is given. The subject is irrelevant.

Initialize the certificate generation helper database before starting Squid.
This is required for the ssl-bump port to start even though the ruleset only
peeks and splices, never bumps. On Squid 5.7 with squid-openssl on Debian
bookworm, omitting this causes startup to fail with "FATAL: The sslcrtd_program
helpers are crashing too rapidly, need help!"

```bash
mkdir -p /var/lib/squid
/usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB
chown -R proxy:proxy /var/lib/squid/ssl_db
```

The parent directory does not exist on a fresh install. The database must be owned
by the proxy user that Squid drops to.

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
# Never change splice to bump below: that would MITM provider traffic and
# expose the credential and every prompt to the proxy.
http_port 172.20.0.1:3128 ssl-bump tls-cert=/etc/squid/dummy.pem
# sslcrtd_program is required for the ssl-bump port to start.
sslcrtd_program /usr/lib/squid/security_file_certgen -s /var/lib/squid/ssl_db -M 4MB
sslcrtd_children 1
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
