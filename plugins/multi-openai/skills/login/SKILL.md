---
name: login
description: Start the official Codex login flow.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

```sh
"$HOME/.local/share/multi-cli/bin/multi" login openai
```

Tell the user to complete the displayed browser or device login, then report
success only after the command exits successfully. Tell the user to relaunch
Claude afterward. Never accept, request, read, or print credentials in chat.
