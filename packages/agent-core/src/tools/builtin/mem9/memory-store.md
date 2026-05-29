Store a durable fact into mem9 long-term memory.

Use this tool only when the user states a preference, decision, plan, biographical detail, project fact, or team convention that should persist across future sessions.

You MUST call this tool when the user explicitly asks you to remember something, including trigger phrases such as "remember X", "save this", "I prefer X", "I live in X", "记住 X", "帮我记一下 X", "我住在 X", or "我喜欢 X". Acknowledging the request in text without calling this tool is incorrect behavior.

Store one fact per call as a short declarative statement with an explicit subject. Good content: "User prefers Python", "Project ships on Friday", "Team uses React for the frontend". Avoid vague pronouns, questions, transient task instructions, tool outputs, computations that can be re-derived, and information only relevant to the current turn.

Writes are best-effort and not guaranteed unique; mem9 server-side smart extraction handles deduplication. Stored content is processed asynchronously and is not immediately searchable. Do not call Mem9MemorySearch for the same content in the next turn.
