# drop-service

A small internal file-drop HTTP service. Teammates on the office network use
it to push a build artifact or log bundle to a shared machine and pull it
back down from another host, and a couple of internal scripts call it to
stage files ahead of a nightly job.

It runs as a single Node process on a small VM behind the office VPN, started
with `npm start`. There is no load balancer or TLS termination in front of
it; anyone who can reach the VPN can reach the port directly. Uploaded files
land under `uploads/` on local disk and are served back out on request.
