- subagents are proper Pi sessions, we dont need to rebuild the core agent loop
- use the Pi RPC to spawn a subagent that lives as a child of the root agent

okay so based on landstrip i think i want to take this implementation for sandboxing first:

for sandboxing, here's the flow when the agent wants to call `git` (via a new shell tool, overriding the default tool)
- every command runs in a default static landlock policy that lets it RW cwd, network access, etc. relatively tight
- if a command fails, the agent can then call the shell tool with `sandbox: false`
- this then falls into auto mode (not implemented yet) which will be a separate model which receives those commands and can say yes/no
- if it says no (lets assume it always says no as auto mode is not implemented), it asks me if i want to run the command
- the command runs unsandboxed, but i know which is the exact command that is run

lets just implement sandboxing first, subagents after sandboxing. can you create a plan file, write it here as sandboxing_plan.md
and lmk so i can review/edit it? you can ask me one or multiple questions as you create the plan and i'll try my best to answer them
