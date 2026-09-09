---
name: connect
description: Connect an OpenCode Zen API key without putting it in chat.
disable-model-invocation: true
allowed-tools: Bash
---

Zen uses an API key, not OAuth. Have the user run this in a separate terminal:

```sh
"$HOME/.local/share/multi-cli/bin/multi" connect zen
```

The helper reuses existing credentials or offers hidden key entry and saves into
OpenCode's auth store. Link https://opencode.ai/auth for creating a key. Do not run
the key-entry prompt through the agent's Bash tool, and never request the key in
chat or as a command argument. If setup is missing, use /multi-core:setup. Tell
the user to relaunch Claude after connecting.
