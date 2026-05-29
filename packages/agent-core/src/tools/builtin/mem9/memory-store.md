Store a durable fact into mem9 long-term memory.

Use this tool only for durable information that should persist across future sessions, including facts about users, projects, teams, organizations, domains, decisions, workflows, incidents, lessons, environments, or other stable context.

You MUST call this tool when the user explicitly asks you to remember, save, keep, record, or use durable information in future sessions. Acknowledging the request in text without calling this tool is incorrect behavior.

Store one fact per call as a short declarative statement with an explicit subject. Good content: "Project ships on Friday", "Team uses React for the frontend", "User prefers Python". Avoid vague pronouns, questions, transient task instructions, tool outputs, computations that can be re-derived, and information only relevant to the current turn.

Writes are best-effort and not guaranteed unique; mem9 server-side smart extraction handles deduplication. Stored content is processed asynchronously and is not immediately searchable. Do not call Mem9MemorySearch for the same content in the next turn.
