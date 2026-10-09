# Active

# Batch 2: Harden the job queue worker

Goal: queue/worker.go retries failed jobs without flooding the broker.

Constraint: broker rate limit is 200 req/s per tenant (confirmed with ops).

## Plan
- [ ] Reproduce the retry flood against the staging broker; verify: broker dashboard shows the spike (executor)
- [ ] Fix the flood; verify: the staging load test stays under the rate limit (executor)

# Open and parked

- Batch 1 follow-up (parked): add queue depth metrics once the dashboard owner replies.
