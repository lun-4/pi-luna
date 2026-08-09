things i wanna steal from claude code
- subagent ui (its okay in cc, but pi-landstrip's subagent ui is very poor. cc's is unstable too, maybe i can make something better?)
- sandboxing (steal from landstrip? maybe?)
- auto mode (commands are sandboxed by default, can select to run unsandboxed, and so they become classified by automode)
  - TODO: which classifier architecture? llm? shieldstral? <sysprompt><tool> or <sysprompt><entire history, tool output stripped>?

things i want from polytoken
- init skill i made (requires subagents)
- plan mode (requires subagents)

list of things to do
- [x] sandboxing policy that fits CC's automode
- [x] make ask prompts emit terminal bell (plan mode?)
- [ ] add RunLua for multitooling? (parallel tooling, filtering tooling, anything the agent might want for token and request efficiency)
- [x] subagents (general purpose and explore subagent for better planning)
- [x] subagent UI fix: footer shouldnt have newlines on the msg
- [ ] subagent UI /agents: the UI is very broken, impossible to actually have pi ui
- [ ] real llm automode?
