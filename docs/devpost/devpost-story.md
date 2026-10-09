INSPIRATION

We love building with AI, but we were frustrated by how much we still had to manage ourselves. Our chats each had useful context, but they couldn't easily work together. We were still the ones finding the right conversation, explaining things again, and moving information between tasks.

That became especially frustrating when we were outside or away from our computers. We wanted to keep work moving without having to sit down, reopen everything and pick up where we left off. Providence grew out of that frustration: one assistant that could bring our conversations and devices together and actually help us follow through.

WHAT IT DOES

Providence gives you one place to direct work across your connected devices and AI conversations. You tell the superagent what you want to get done. It finds relevant context from the conversations you've connected, delegates work to agents on the right devices, and brings their progress and results back to you.

For developers, this means a task can move from planning to implementation to review without manually carrying the context between every chat. Individual conversations stay available, but you can follow the whole task from the main interface.

HOW WE BUILT IT

OpenAI Codex was our primary building tool throughout the hackathon. We built Providence with two ChatGPT Codex subscriptions, using two weekly usage allowances on each. We used it to write code, debug problems, review changes and build tests. It also provides the reasoning and execution tools that power Providence itself.

We built a TypeScript and Node.js coordinator, a React interface, and device connections using WebSockets. Our work focused on connecting conversations, passing relevant context, routing tasks, handling permissions, and returning files and results. We also built Watch and Quest clients around the same coordinator.

CHALLENGES

Keeping the main conversation in sync with the actual work was harder than we expected. A worker could still be running after the superagent had finished replying, or a device could disconnect halfway through a task. We had to work through recovery, permissions and stale updates so the interface showed what was really happening.

We also wanted the interface to feel simple without hiding the work. That meant keeping one main conversation while making individual tasks and decisions easy to inspect.

ACCOMPLISHMENTS

We got requests from our website to perform real browser and native-app actions on a Mac and return the results.

In a test scenario, a Mac agent built a signup page, a Windows agent prepared its release summary, and a separate Mac agent reviewed the work and reran the tests. In a team test, a typed Apple Watch request also opened a page on the Mac and returned the result to the Watch. Seeing those pieces work together made the idea feel real.

WHAT WE LEARNED

An agent saying “done” isn't enough. We had to check the actual apps and files, not just the response. We learned that useful multi-agent software depends just as much on keeping context, tracking work and recovering from failures as it does on the model itself.

WHAT'S NEXT

We're improving device reconnection and response times, and finishing voice and physical Quest testing. We want Providence to become something we can rely on throughout the day, whether we're developing at a desk or continuing a task while we're out.
