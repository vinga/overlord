- sessoin templates (autonomous agent, yes-no-asking agent)
- - ASKS for permissions arent visible



### MANDATORY: No inline code changes

**Every code change, no matter how small, MUST be delegated to a subagent.** This is non-negotiable.

- A one-line CSS tweak → subagent
- Renaming a variable → subagent
- Adding a tooltip → subagent

Never edit files directly in the main conversation. The main conversation is for coordination, planning, and communication only. If you find yourself reaching for Edit, Write, or Read on a source file — stop and spawn a subagent instead.
