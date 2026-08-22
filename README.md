> [!NOTE]
> Don't use this. There is a first-party CLI in the vikunja repo [veans](https://github.com/go-vikunja/vikunja/tree/main/veans) and several in-progress MCP PRs.

# vik

vikunja cli client for agents

## features

- all output is raw json unless otherwise specified; users can use jq to filter down if they want
- use an API token from `VIKUNJA_TOKEN`
- look at vikunja.yaml and .vikunja.yaml paths for config; the config format should have `username`, `server`, `project`
- list tasks in current project (optionally filter by status, maybe take a sort key)
- modify tasks (change owner, modify state)
- comment on tasks
- create tasks in current project
- support file attachments / embeds in markdown (whatever vikunja itself supports). goal is to handle images and PDFs probably
- for long description text, when the user passes `--description -`, read from stdin

## usage

Installation:

```sh
# I haven't tested this
cargo install --git https://github.com/abe-winter/vik
```

Project directory setup:
- get an api token from your vikunja instance
  - it should have the standard task rw permissions plus /users
  - use mise / fnox or something to set the `VIKUNJA_TOKEN` env var
- drop AGENTS.sample.md from this repo as AGENTS.md or CLAUDE.md. It has a list of key commands and workflow your agent will need to know
- create a vikunja.yaml as below

```yaml
# vikunja.yaml
server: vikunja.example.com
project: 13 # you can get the ID from the URL in vikunja web
username: me # used by --mine flags for filtering and claiming
```
