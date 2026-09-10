## Summary

{Describe the user-visible change in one to three sentences. Name the most important boundary or
compatibility guarantee.}

## Implementation

### {Area or surface}

- {Describe one coherent implementation topic.}
- {Name the relevant files, flag, or contract only when it helps the reviewer.}

### Behavior preserved

- {Behavior or contract that remains unchanged.}
- {Control, accessibility behavior, or fallback path that remains available.}

### How to see it

{Give the shortest reliable path to the changed state. Include feature flags, input mode, viewport,
or session requirements when they matter.}

## Verification

- `{verification command}`: {result}
- `{focused verification command}`: {result}

Still to verify:

- {Hardware, browser, environment, or rollout check that was not run.}

### Screenshots

#### {Scenario name}

{State the seeded state, flag combination, viewport, or interaction shown.}

| Before (`{base-branch}@{base-sha}`)                                                            | After (`{head-branch}@{head-sha}`)                                                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| <img width="{width}" height="{height}" alt="{surface}-before" src="{github-attachment-url}" /> | <img width="{width}" height="{height}" alt="{surface}-after" src="{github-attachment-url}" /> |

#### {Second scenario name}

{Add another pair only when it covers a materially different state.}

| Before (`{base-branch}@{base-sha}`)                                                                   | After (`{head-branch}@{head-sha}`)                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| <img width="{width}" height="{height}" alt="{second-surface}-before" src="{github-attachment-url}" /> | <img width="{width}" height="{height}" alt="{second-surface}-after" src="{github-attachment-url}" /> |
