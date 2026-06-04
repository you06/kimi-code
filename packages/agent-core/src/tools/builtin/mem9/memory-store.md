Store a durable fact into mem9 long-term memory.

Use this tool only for durable information that should persist across future sessions, including facts about users, projects, teams, organizations, domains, decisions, workflows, incidents, lessons, environments, or other stable context.

You MUST call this tool when the user explicitly asks you to remember, save, keep, record, or use durable information in future sessions. Acknowledging the request in text without calling this tool is incorrect behavior.

Store one fact per call as a short declarative statement with an explicit subject. Good content: "Project ships on Friday", "Team uses React for the frontend", "User prefers Python". Avoid vague pronouns, questions, transient task instructions, tool outputs, computations that can be re-derived, and information only relevant to the current turn.

# Generating retrieval keys

Pass `retrieval_keys` with 3–7 short query phrases that describe how a future agent (you or another) will look this fact up. mem9 indexes those keys; recall happens by matching what an agent says against the keys you stored. If you skip this field, mem9 falls back to a generic server-side LLM extractor that does not see your conversation context, your tools, or your system prompt, so the keys it picks tend to be noisier — prefer providing keys yourself.

Each key:

- Is a short DECLARATIVE phrase, NOT a question. ("user lives in" is OK; "where does the user live?" is NOT.)
- Is at most 8 words. Shorter is fine if it stays meaningful on its own.
- Contains EITHER a predicate fragment with its preposition ("user works at", "team deploys on", "project uses") OR a named entity from the fact ("Acme Robotics", "千葉", "PostgreSQL"). The strongest keys combine both: "user works at Acme Robotics", "project deploys on Kubernetes".
- Shares at least one token with the fact's content. Pure synonyms with no token overlap get rejected by mem9 ("residence" is bad if the fact says "lives in"; "lives in" or "home location" is good).

Single-token generic words — `user`, `home`, `work`, `team`, `project`, `company`, `name`, `date`, `time`, `place` — are rejected by mem9 server. They collide with thousands of unrelated memories and produce noisy recall. Don't pass them.

When the fact contains a named entity that a user may search for in another language, also add 1–2 cross-language keys with `source: "agent_translation"`. For example, if the fact is "Company office is at Otemachi, Tokyo", a good `agent_translation` key is "会社の所在地 大手町".

`weight` is optional and defaults to 1.0. Use higher (≈1.3–1.5) for keys that combine a predicate AND a named entity; use lower (≈0.5–0.8) for entity-only keys.

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
