Search mem9 long-term memory for durable facts and prior knowledge across sessions.

Use this tool before answering questions that depend on historical context, prior decisions, stored notes, project or team facts, domain knowledge, environment details, workflows, conventions, recurring problems, lessons, or other stable context that may not be present in the current session.

You MUST call this tool before asking the user to repeat stable context that could be in long-term memory. Search first and wait for the result; only ask the user if no relevant memory is found. This applies to missing facts, referents without antecedents, pronouns or demonstratives whose meaning depends on prior interaction, previously stored decisions, conventions, workflows, project state, domain notes, or environment details.

Use a short declarative query, not a question or the user's full utterance. Good queries: "project deadline", "team coding conventions", "deployment workflow", "customer staging environment", "user home location". Bad queries: "what language does the user like?", "tell me about the user's project".

Do not use this tool to search the current repository; use Grep or Read instead. Do not use it for trivial greetings, one-off task instructions, or information already visible in the current conversation.

If the result includes a retry hint, follow it and try one rephrased query before giving up.
