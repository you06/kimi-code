Store a durable fact into mem9 long-term memory.

Use this tool only for durable information that should persist across future sessions, including facts about users, projects, teams, organizations, domains, decisions, workflows, incidents, lessons, environments, or other stable context.

You MUST call this tool when the user explicitly asks you to remember, save, keep, record, or use durable information in future sessions. Acknowledging the request in text without calling this tool is incorrect behavior.

Store one fact per call as a short declarative statement with an explicit subject. Good content: "Project ships on Friday", "Team uses React for the frontend", "User prefers Python". Avoid vague pronouns, questions, transient task instructions, tool outputs, computations that can be re-derived, and information only relevant to the current turn.

# Specificity

Preserve specific object, place, and name words verbatim in the fact — do not generalize details away. "She made a cup in pottery class" must not become "she made pottery": the word "cup" is exactly what a future question will ask about, and once it is generalized at store time no amount of searching can recover it. When a statement mentions several distinct items, keep every distinct item word in the stored fact — including decorations and depictions ("a cup with a dog face on it", not just "a cup").

Keep the connecting frame that situates a fact: the occasion, cause, or purpose it was said with. "Self-care is important to her" stored without "after running the charity race" loses what the reflection was about; "researching agencies" without "as part of her summer plans" loses the plan it belongs to. The frame words are often exactly what a future question asks for, and a fact stripped of its frame answers a different question than the one that will be asked.

# Attribution

Attribute every fact to the person it is actually about — the speaker is not automatically the subject. If the user talks about their friend's grandmother coming from Ireland, that fact belongs to the friend's family; storing it as the user's grandmother (or "the user is from Ireland") fabricates a biography. Possessions, artworks, pets, and relatives mentioned in a conversation each belong to one specific person: name that person in the stored fact, and re-check the attribution before storing. Scope words must also match what was said — "her other children were scared" excludes a child the speaker actually included, and "all"/"only"/"except" change who a fact covers.

# Traceability

Store only facts that are traceable to what was actually said in the conversation. Never add details, attributions, or explanations that were not stated — if the conversation says "some people upset her on a hike", store that, not a guess about who those people were. When in doubt whether a detail was stated or inferred, leave the detail out.

# Temporal normalization

When the conversation contains a relative time reference — "last week", "yesterday", "two days ago", "last Friday", "this morning", "next month" — resolve it to an absolute date before storing the fact, provided the surrounding context gives you a reliable anchor (a system-supplied session date, a date stated earlier in the conversation, or the timestamp of the message itself). A future agent reading this memory in a different session will not know what "last week" referred to, so storing only the relative phrase makes the fact unusable for cross-session recall.

Store ONLY the resolved absolute form. Do not keep the original relative phrase — not even in parentheses. A relative phrase's meaning dies at store time: a future reader's "last Tuesday" is anchored to a different "now" than yours, so retained relative wording can only mislead — it baits later retrieval into false matches and baits the answering model into recomputing dates against the wrong present.

Examples (assume context tells you the reference date is 25 August 2023):

- ❌ "User went hiking last week and had a negative encounter."
- ❌ "User went hiking around 18 August 2023 ('last week') and had a negative encounter."
- ✅ "User went hiking around 18 August 2023 and had a negative encounter."

- ❌ "User finished the report yesterday."
- ✅ "User finished the report on 24 August 2023."

If the context does not give you a clear anchor date — for example, an offhand reference like "I worked on this recently" with no system date, no prior dated turn, and no message timestamp — preserve the original wording rather than inventing precision. Storing "User worked on the report recently" is fine when no anchor is available; making up "around 20 August 2023" is not.

Periodic schedules ("every Friday", "weekly", "monthly") are not relative time references and should be stored as-is.

# Generating retrieval keys

Pass `retrieval_keys` with 3–7 short query phrases that describe how a future agent (you or another) will look this fact up. mem9 indexes those keys; recall happens by matching what an agent says against the keys you stored. If you skip this field, mem9 falls back to a generic server-side LLM extractor that does not see your conversation context, your tools, or your system prompt, so the keys it picks tend to be noisier — prefer providing keys yourself.

Each key:

- Is a short DECLARATIVE phrase, NOT a question. ("user lives in" is OK; "where does the user live?" is NOT.)
- Is at most 8 words. Shorter is fine if it stays meaningful on its own.
- Contains EITHER a predicate fragment with its preposition ("user works at", "team deploys on", "project uses") OR a named entity from the fact ("Acme Robotics", "千葉", "PostgreSQL"). The strongest keys combine both: "user works at Acme Robotics", "project deploys on Kubernetes".
- Shares at least one token with the fact's content. Pure synonyms with no token overlap get rejected by mem9 ("residence" is bad if the fact says "lives in"; "lives in" or "home location" is good).

Single-token generic words — `user`, `home`, `work`, `team`, `project`, `company`, `name`, `date`, `time`, `place` — are rejected by mem9 server. They collide with thousands of unrelated memories and produce noisy recall. Don't pass them.

When the fact contains a named entity that a user may search for in another language, also add 1–2 cross-language keys with `source: "agent_translation"`. For example, if the fact is "Company office is at Otemachi, Tokyo", a good `agent_translation` key is "会社の所在地 大手町".

When the fact is an instance of a broader recurring category — an activity, hobby, skill, place type, food or media preference — also add 1–2 CATEGORY keys phrased the way a future aggregate question would ask, and include the subject's name in them (the name keeps the key anchored and satisfies the token-overlap rule). For the fact "Melanie went swimming with her kids", good category keys are "Melanie activities" and "Melanie family activities": a future "what does Melanie do with her kids?" search matches the category key even though "swimming" never appears in the query. Without a category key, aggregate searches can only find this fact if the searcher already guesses the specific word. Skip category keys for one-off facts that belong to no recurring category.

`weight` is optional and defaults to 1.0. Use higher (≈1.3–1.5) for keys that combine a predicate AND a named entity; use lower (≈0.5–0.8) for entity-only keys; category keys read well at ≈0.8–1.0.

# Examples

Fact: "User lives in Chiba Prefecture, Japan and commutes to Otemachi, Tokyo for work."

```json
{
  "content": "User lives in Chiba Prefecture, Japan and commutes to Otemachi, Tokyo for work.",
  "retrieval_keys": [
    { "text": "user lives in Chiba", "source": "agent", "weight": 1.4 },
    { "text": "user commutes to Otemachi", "source": "agent", "weight": 1.4 },
    { "text": "user home Chiba Prefecture", "source": "agent", "weight": 1.0 },
    { "text": "Otemachi Tokyo work location", "source": "agent", "weight": 0.8 },
    { "text": "ユーザーの自宅 千葉県", "source": "agent_translation", "weight": 0.8 }
  ]
}
```

Fact: "Project ships every Friday at 4pm JST after the weekly demo."

```json
{
  "content": "Project ships every Friday at 4pm JST after the weekly demo.",
  "retrieval_keys": [
    { "text": "project ships on Friday", "source": "agent", "weight": 1.4 },
    { "text": "project release time 4pm JST", "source": "agent", "weight": 1.2 },
    { "text": "project ships after weekly demo", "source": "agent", "weight": 1.0 }
  ]
}
```

# Response

mem9 returns `Retrieval keys accepted` (how many of your keys it kept) and, on the sync path, `Retrieval keys rejected` (which ones it dropped and why). When a key is rejected, fix it before re-storing the fact — common reasons are stop-list words, missing predicate, or no token overlap with the content.

Writes are best-effort and not guaranteed unique; mem9 server-side smart extraction handles deduplication. Stored content is processed asynchronously and is not immediately searchable. Do not call Mem9MemorySearch for the same content in the next turn.
