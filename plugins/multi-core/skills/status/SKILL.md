---
name: status
description: Show enabled Multi providers and the local runtime status.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

```sh
"$HOME/.local/share/multi-cli/bin/multi" status
```

Tell the user which providers are enabled and whether the helper is installed.
This command does not test provider authentication or inference. If it is missing,
tell the user to run `/multi-core:setup`. Never accept credentials in chat.
