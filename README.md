# agent-flow (with pets)

A Claude Code mod: a side pane that draws the session's agent flow live — the main loop's context, every subagent as a tree, what each one was handed, did and returned. Running agents show as animated pets.

Fork of `agent-flow` from [claude-code-templates](https://github.com/davila7/claude-code-templates) (MIT).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-flow --marketplace kongpop1405/agent-flow-pets
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install agent-flow --marketplace kongpop1405/agent-flow-pets
```

## Use

`/agent-flow` opens the pane (docked beside the transcript in `/tui fullscreen`, above the prompt otherwise). `/agent-flow stop` closes it.

## License

MIT — see [LICENSE](LICENSE).
