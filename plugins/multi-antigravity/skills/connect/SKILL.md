---
name: connect
description: Configure the scoped native Antigravity permission hook.
disable-model-invocation: true
allowed-tools: Bash
---

Have the user complete the official agy CLI's native login in their terminal.
Then run:

```sh
"$HOME/.local/share/multi-cli/bin/multi" login antigravity
```

This installs the scoped permission hook; it does not perform OAuth or test
inference. Tell the user to relaunch Claude. Native credentials stay owned by agy.
Do not extract Google tokens or run provider inference to verify installation.
