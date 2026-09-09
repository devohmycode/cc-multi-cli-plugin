---
name: login
description: Start the official openai browser login.
disable-model-invocation: true
allowed-tools: Bash
---

Run this fixed helper with a timeout long enough for browser sign-in:

```sh
"$HOME/.local/share/multi-cli/bin/multi" login openai
```

Show the provider's login URL and let the user complete authentication in their
browser. Keep the login process alive while they do so; report completion only
when it exits successfully. For remote/headless login, append --device-auth if supported by the account. If setup is missing, use /multi-core:setup.
Never read, print or ask for tokens/passwords. Credential persistence and refresh
belong to the official provider CLI/SDK. Tell the user to relaunch Claude after
successful login so its models and workers can be registered.
