# Context caching in Gemini 3, and how to wire it into a chatbot

This is a design guide, not a lab walkthrough. It explains what Gemini 3 context caching actually
guarantees, then gives an integration plan for a chat application: what belongs in a cache, what does
not, and why the conversation history is deliberately left out.

For the hands-on lab — creating a real cache, changing its expiration, proving a hit — see
[cache.en.md](../tests/cache.en.md).

---

## 1. Two different caches

Gemini has two caching mechanisms. They are not alternatives; they stack, and confusing them is the
most common source of wrong design decisions.

| | Implicit caching | Explicit caching |
| --- | --- | --- |
| Who triggers it | The service, automatically. Enabled by default on every Google Cloud project; there is no request flag | You, with a `cachedContents` resource |
| What it matches | A shared **prefix** with a recent request | A named resource you created |
| Guarantee | Best-effort. Eligible on every supported call; no promise of a hit | Deterministic. The content is there until it expires |
| You manage | Nothing. Do not “turn it on” in chat code | Creation, expiration, deletion, billing |
| Proof of a hit | `cachedContentTokenCount`, when it happens. Missing or `0` is a miss, not “disabled” | `cachedContentTokenCount`, always |
| Cost | Free discount when it hits. No storage bill | Discounted input tokens **plus** storage billed over time |

The practical consequence: **implicit caching is the mechanism that *may* discount the growing
conversation prefix, for free, with no resource to manage.** Explicit caching is for the large,
stable blob you want a guaranteed, provable hit on. Auto-enabled is not the same as “every
follow-up will show cached tokens.”

## 2. The five constraints that drive every decision

Everything below follows from these. They are not incidental API details — they determine the shape
of any correct integration.

1. **Content is immutable.** Model, contents, system instruction, display name, and encryption key
   are fixed at creation. Only the expiration can be changed afterwards. To "change" a cache you
   create a new one.
2. **There is a minimum size.** Gemini 3 explicit caches require at least ~4,096 input tokens.
   Smaller material is rejected — you cannot cache a short system prompt.
3. **Storage is billed over wall-clock time.** You pay for cached tokens × how long they exist,
   whether or not any request uses them. An unused cache with a 1-hour TTL costs the full hour.
4. **A cache is pinned to one project, one location, and one model.** Switching any of them means
   the cache is unusable, and you need a new one.
5. **It expires.** Either a `ttl` duration or an absolute `expireTime`. After that the resource is
   gone and requests referencing it fail.

## 3. What to cache, and what not to

The test is simple: **cache what is large, stable, and reused across many requests.**

| Content | Cache it? | Reasoning |
| --- | --- | --- |
| Uploaded documents, PDFs, transcripts | **Yes** | Large, immutable, referenced on every turn |
| System instruction / persona | **Yes**, bundled with the above | Stable, and it must live in the cache to avoid a duplicate |
| Few-shot examples, style guides | **Yes** | Large and fixed for the life of the assistant |
| Long tool/function schemas | **Yes**, if stable | Same profile as few-shot examples |
| Retrieved RAG chunks | **Usually no** | Different chunks per query; nothing is reused |
| The conversation history | **No** — see §4 | Grows every turn; immutability makes it a poor fit |
| The user's new question | **Never** | Different every request by definition |

A useful reframe: a cache is a **snapshot**, not a buffer. If the content will be different next
turn, it does not belong in a snapshot.

## 4. Why the conversation history stays out of the cache

This is the decision most worth understanding, because it looks backwards at first. The history is
resent in full on every turn, and the files are not. Why cache the thing that never changes and
resend the thing that grows?

### The immutability argument

A cache cannot be appended to. "Cache the conversation" therefore means "create a new cache every
turn," because turn 5's message cannot be inside a cache created at turn 1.

Now count what that costs on a 20-turn conversation:

- **20 create calls.** Each one processes the whole history again to build the cache. That is the
  same token processing you were trying to avoid — you have moved the cost, not removed it.
- **19 superseded caches, all still billing.** Deleting a cache stops future storage charges, but
  each cache you replace has been paid for from creation until you delete it. Forget to delete and
  they bill for their full TTL.
- **A hit that saves less than you think.** The cache only covers the prefix as of its creation.
  Every turn after that still sends its own delta uncached.

The write cost alone roughly cancels the read savings. Storage cost is then pure loss. Explicit
caching of a per-turn-changing prefix is a net negative in almost every case.

### The thing that already solves it

Implicit caching matches on a shared prefix with a recent request — which is precisely the shape of
a chat conversation: identical history, one new turn appended. You do not create, track, expire, or
delete anything. The service is already allowed to reuse that prefix.

That is the whole chat implementation for implicit: keep the large stable text first (a
`systemInstruction` or the first user part), resend the same history prefix on every turn, stay
above the Gemini 3 minimum of ~4,096 tokens, and read `cachedContentTokenCount`. The first turn
usually writes. A later turn *can* hit. Gemini 3 often needs a third call before the field appears.
A miss after a correct prefix is normal.

So the split is not arbitrary:

- **Explicit cache** → the big immutable blob (files + system instruction). Guaranteed, provable.
- **Implicit cache** → the growing conversation prefix. Free, automatic, best-effort. Do not
  implement an “enable implicit” switch.

### The one exception

Periodic re-caching — creating a fresh cache every *N* turns rather than every turn — can pay off
when the history is both very large and very stable, so the create cost amortizes across N hits. It
means managing a rolling window of caches and a policy for when the prefix has grown enough to
justify a new one. Treat it as an optimization to reach for only with measurements in hand, not a
starting design.

## 5. Integration plan for a chatbot

### 5.1 Fingerprint the material

Derive a stable signature from **everything immutable about the cache**:

```
signature = hash(model + location + systemInstruction + [file identity for each file])
```

Use file identity that is cheap to compute — name plus byte size — not the encoded contents. This
matters: if the signature needs the base64 payload, you re-encode every file on every message just
to discover you already have a cache.

The signature is the reuse key. Any change to the model, the location, the system instruction, or
the file set produces a different signature, which correctly forces a new cache — because those are
exactly the fields the API will not let you change.

### 5.2 Keep a local registry

Store one record per cache you create. The minimum useful shape:

```json
{
  "name": "projects/PROJECT/locations/LOCATION/cachedContents/CACHE_ID",
  "displayName": "assistant-docs-3f2a",
  "model": "gemini-3.6-flash",
  "region": "europe-west2",
  "signature": "3f2a1b-2c",
  "createdAt": "2026-08-15T19:29:26Z",
  "expireTime": "2026-08-15T20:29:26Z",
  "cachedTokens": 9819
}
```

**Save this:**

- `name` — the only way to reference, update, or delete the cache.
- `expireTime` — so you never send a dead cache. Treat this as authoritative.
- `signature`, `model`, `region` — the reuse key, all three must match.
- `cachedTokens` — what you are being billed to store, and the number to compare hits against.

**Do not save this:**

- The cached content itself. It lives at Google; a local copy is a stale duplicate.
- Conversation messages. Those belong to your normal chat storage, not the cache registry.
- Anything derived that you can recompute — remaining TTL is `expireTime - now`, not a stored field
  that goes stale the moment you write it.

**Filter expired entries on read, not on a timer.** A record whose `expireTime` has passed must
never be selectable for a request. Enforcing that at the point of reading the registry means there
is no window where a background job has not yet run and a dead cache gets used.

### 5.3 Resolve the cache before each request

```
resolveCache(conversation):
    if not cacheEnabled:              return none
    if provider is not Vertex:        return none        # explicit caching is a Vertex feature
    files = all files in conversation
    if files is empty:                return none        # nothing worth caching

    signature = fingerprint(model, region, systemInstruction, files)

    hit = registry.findLive(signature, model, region)
    if hit:                           return hit.name    # the common path

    if signature in refusedThisSession: return none      # do not retry a doomed create
    if model not in cacheCapableModels: return none
    if materialIsTextOnly and estimatedTokens < 4096: return none

    created = createCache(model, region, systemInstruction, files, ttl)
    on failure: remember refusal, return none
    registry.remember(created)
    return created.name
```

Every early return is a real limit worth surfacing to the user rather than failing silently. The
refusal memo matters: without it, a conversation whose material sits under the minimum attempts a
doomed create on every single message.

### 5.4 Assemble the request

When a cache is attached, **remove from the request whatever the cache already holds**:

```json
{
  "cachedContent": "projects/PROJECT/locations/LOCATION/cachedContents/CACHE_ID",
  "contents": [
    { "role": "user",  "parts": [{ "text": "First question" }] },
    { "role": "model", "parts": [{ "text": "First answer" }] },
    { "role": "user",  "parts": [{ "text": "The new question" }] }
  ],
  "generationConfig": {
    "temperature": 0.2,
    "maxOutputTokens": 2048,
    "thinkingConfig": { "thinkingLevel": "low" }
  }
}
```

Three rules:

1. **Do not resend the files.** That is the entire point.
2. **Do not send `systemInstruction`** alongside a cache that contains one. It is redundant, and the
   API rejects the duplicate.
3. **Do send the full conversation text.** It is not in the cache. See §4.

### 5.5 Verify, do not assume

```
usageMetadata.cachedContentTokenCount
```

A positive value is the provider's own evidence that cached input was used. Latency is not proof —
network variance, capacity, and output length move it around far more than a cache hit does.

When an **explicit** cache is attached, expect `cachedContentTokenCount` to stay near the stored
total while `promptTokenCount` grows each turn. That gap is the conversation history, and seeing it
behave that way confirms the split in §4 is working as designed.

When the request has **no** `cachedContent` field, a positive count is an implicit hit. The field
may be omitted entirely. That does not mean implicit caching is off. It means this turn missed.

### 5.6 Handle expiry as a normal event, not an error

A cache expiring mid-conversation is routine. The next `resolveCache` finds no live entry, creates a
fresh one, and the conversation continues. Users should never see a failure for this. What they
should see is a note that a new cache was created, because it costs money.

## 6. Operational guardrails

- **Never auto-create without a visible switch.** Cache creation is billable and irreversible for
  the length of its TTL. Default it off.
- **Show every live cache with a countdown and a delete button.** Users who can see what they are
  paying for will delete what they do not need.
- **Delete superseded caches deliberately.** Changing the model or system instruction orphans the
  old cache; it keeps billing until its TTL runs out.
- **Pick a TTL that matches the session, not the maximum.** Storage is billed for the whole TTL
  whether used or not. An hour is a reasonable default for interactive chat.
- **Watch the minimum.** Material under ~4,096 tokens cannot be cached. Detect it up front for
  text; for PDFs only the service can count, so handle the rejection gracefully.
- **CMEK is unavailable on the global endpoint.** If you need customer-managed keys, choose a
  regional location, and set the key at creation — it is immutable too.

## 7. A trap worth knowing: thinking tokens and the output budget

Unrelated to caching, but it will bite during integration testing.

Gemini 3 thinking tokens are drawn from `maxOutputTokens` but reported separately as
`thoughtsTokenCount` — they are **not** included in `candidatesTokenCount`. A response can stop with
`finishReason: MAX_TOKENS` after a dozen visible tokens:

```json
{
  "finishReason": "MAX_TOKENS",
  "usageMetadata": {
    "candidatesTokenCount": 17,
    "thoughtsTokenCount": 491
  }
}
```

17 + 491 = 508, against a budget of 512. The answer was truncated by reasoning, not by length. Add
the two counts before concluding a budget is large enough, and either raise `maxOutputTokens` or set
`generationConfig.thinkingConfig.thinkingLevel` to `low`.

## 8. Implementation checklist

- [ ] Explicit caching enabled behind an off-by-default switch
- [ ] Signature computed from cheap file identity, not encoded payloads
- [ ] Registry storing `name`, `expireTime`, `signature`, `model`, `region`, `cachedTokens`
- [ ] Expired entries filtered at read time
- [ ] Files stripped from requests when a cache is attached
- [ ] `systemInstruction` omitted when the cache carries one
- [ ] Conversation text still sent in full
- [ ] Region of the cache validated against the region of the request
- [ ] Failed creates remembered per-signature, not retried per-message
- [ ] `cachedContentTokenCount` surfaced in the UI as hit evidence
- [ ] Implicit misses labeled as misses, not as “cache not requested”
- [ ] Large stable chat context placed first (`systemInstruction` or first part)
- [ ] Live caches listed with TTL countdown and delete
- [ ] `thoughtsTokenCount` added to output accounting

## 9. References

- Vertex AI context caching overview and API reference
- Gemini API caching documentation (implicit and explicit)
- Vertex AI pricing, for the current cached-input and storage rates
