Search mem9 long-term memory for durable facts about the user, project, team, or prior decisions.

Use this tool before answering questions that depend on historical context, preferences, prior decisions, or stable project/team facts that may not be present in the current session.

You MUST call this tool before asking the user to repeat stable context that could be in long-term memory. Examples include "my home", "from my place", "where I live", "my city", "my preference", "our previous decision", "我家", "我住哪", "我所在的城市", "我的偏好", or "我们之前决定".

Use a short declarative query, not a question or the user's full utterance. Good queries: "user prefers Python", "project deadline", "team coding conventions". Bad queries: "what language does the user like?", "tell me about the user's project".

Do not use this tool to search the current repository; use Grep or Read instead. Do not use it for trivial greetings, one-off task instructions, or information already visible in the current conversation.

If the result includes a retry hint, follow it and try one rephrased query before giving up.
