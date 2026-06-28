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
