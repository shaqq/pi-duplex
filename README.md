# pi-duplex

pi-duplex gives [Pi](https://pi.dev) two cooperating agents:

- A fast **foreground** answers simple questions and stays responsive.
- A persistent **reasoner** handles substantive work with Pi's normal tools and
  speaks directly in the transcript.

You keep using Pi normally. While the reasoner works, the foreground can answer
a side question, update the active task, queue later work, or stop the task.

## Install

Requires Pi 0.84.3 or newer.

These examples use Codex because I have a ChatGPT subscription, but any Pi
provider works.

```bash
pi install npm:pi-duplex
```

Log into Codex through Pi:

```text
/login openai-codex
```

Then start Pi with a fast foreground model and a smart reasoner model:

```bash
PI_DUPLEX_REASONER_MODEL=openai-codex/gpt-5.6-sol \
PI_DUPLEX_REASONER_THINKING=max \
pi --model openai-codex/gpt-5.6-luna:medium
```

The reasoner appears in a different color. Use `/reasoner-model` to switch its
model and `Ctrl+O` to expand its tool calls. Pi keeps the first `Escape` for its
foreground work; press `Escape` twice to stop an active reasoner.

## Models

The foreground uses whatever model is selected in Pi. The reasoner must be set
with `PI_DUPLEX_REASONER_MODEL` before Pi starts. Its optional
`PI_DUPLEX_REASONER_THINKING` setting defaults to `max`.

For an open-weight setup, try
[DeepSeek V4 Flash](https://artificialanalysis.ai/models/deepseek-v4-flash) as
the fast foreground and
[Kimi K3](https://artificialanalysis.ai/models/kimi-k3/) as the reasoner.
After setting `DEEPSEEK_API_KEY` and `MOONSHOT_API_KEY`:

```bash
PI_DUPLEX_REASONER_MODEL=moonshotai/kimi-k3 \
PI_DUPLEX_REASONER_THINKING=max \
pi --model deepseek/deepseek-v4-flash:low
```

Of course, you can use whichever model combination you'd like!

MIT licensed.
