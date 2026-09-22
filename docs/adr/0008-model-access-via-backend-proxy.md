# 0008 — All model access through a backend proxy

**Status:** Accepted

## Context

cognis makes model calls for concept disambiguation, quiz item generation and
answer grading. The obvious local-first instinct is to call the provider directly
from the device, keeping the architecture serverless.

That requires a provider API key in the app binary. Keys in mobile binaries are
extractable from any installed copy — this is a routine exercise, not an advanced
attack — and an extracted key is an open-ended bill against the developer's
account with no per-user attribution and no way to revoke one user without
revoking everyone.

## Decision

All model calls go through a backend proxy holding the provider credentials. The
client never sees a key. The proxy authenticates the user, enforces per-user
quotas, applies the redaction rules from [09](../09-privacy-and-security.md), and
writes nothing to disk beyond job state.

Quotas are a security control, not merely a billing one: they bound the damage
from a compromised or abusive client.

## Consequences

- Provider credentials are never distributed.
- Batching and prompt caching are implementable centrally, which is where the
  cost savings in [08](../08-llm-integration.md) actually come from — per-device
  calls would fragment cache prefixes and forfeit batch pricing.
- Rate limits, retries, refusal fallbacks and model version pinning live in one
  place and can change without an app release.
- Cost: the three model-dependent stages require network. Acceptable — they are
  deferred and batched anyway, and the local-only mode in
  [09](../09-privacy-and-security.md) degrades gracefully without them.
- Cost: an operational component to run, and a component that *could* see
  content, which is why egress logging, minimisation and the per-source private
  flag are mandatory rather than optional.
- Cost: a self-hosting user needs to run the proxy. It is small and stateless by
  design, so this stays feasible.

## Alternatives considered

**Bring-your-own-key on device.** Removes the proxy and appeals to the local-first
instinct. Rejected as a default: it pushes key management onto users, loses
central batching and caching, and most people will not do it. Worth offering as
an advanced option for users who want zero third-party involvement, and it fits
the port abstraction without redesign.

**On-device models for linking and grading.** The right long-term answer for
privacy, and not yet a good trade for linking quality on a phone. The `Linker`
and `Grader` ports mean this can be adopted per-stage when it becomes viable —
plausibly for grading before linking.

**Direct calls with a short-lived token minted by a server.** Still requires a
server, and gives up central batching and caching for no privacy gain, since the
content reaches the provider either way.
