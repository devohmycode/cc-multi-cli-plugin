---
name: login
description: Start the official Cursor SDK login flow.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

```sh
"$HOME/.local/share/multi-cli/bin/multi" login cursor
```

Tell the user to complete the displayed browser login, then report success only
after the command exits successfully. Tell the user to relaunch Claude afterward.
Never accept, request, read, or print credentials in chat.
