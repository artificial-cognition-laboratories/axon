full axon documentation for agents. the module mounts the docs to `process.env.AXON_HOME/data/knowledge` where it can be discovered by the agent.

this gives agents the ability to create agents, install and search for modules, create and manage your terminal configuration and more.

Here is an example of `@axon/zeno` creating a new theme for the axon terminal:
[video of axon agent creating a new theme](./assets/demo.mp4)

to give your agent the docs, simply install the module:

```bash
axon install @axon/docs
```

or from the tui:

```bash
: module install @axon/docs
```