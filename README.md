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

Build with `cargo build` (a release binary lands at `target/release/vik`).

Config — `./.vikunja.yaml`, `./vikunja.yaml`, then `~/.vikunja.yaml` (first match wins).
The token is never stored in config; it comes from `VIKUNJA_TOKEN` (or `--token`).
Precedence for every setting is flag > env > config file.

```yaml
# vikunja.yaml
server: vikunja.example.com   # scheme optional; defaults to https://
project: 13                   # id, or a project name/identifier
username: me                  # used by --mine (list filters by it; modify resolves it to a user id)
```

```sh
export VIKUNJA_TOKEN=tk_...

vik projects                                   # list projects (find an id)
vik list                                       # tasks in the configured project
vik list --done false --sort-by priority --order-by desc
vik list -s "search text" --filter "priority >= 4"
vik list --mine                                # tasks assigned to me (config username)
vik list --topo-sort                           # blocker order: tasks that block others first (id tie-break)

vik create "write the docs" --priority 3 --due-date 2026-07-01T17:00:00Z
echo "long body" | vik create "task" --description -

vik modify 25 --done true --priority 5         # safe partial update (read-merge-write)
vik modify 25 --assignee 2                      # assignee by id (username needs /users token scope)
vik modify 25 --mine                            # assign to me (config username)

vik comment 25 "looks good"
git log -1 --format=%B | vik comment 25 -       # comment body from stdin

vik attachments 25                              # list attachments
vik attach 25 diagram.png report.pdf            # upload file(s)
vik attach 25 diagram.png --embed               # upload + embed image in the description
```

All commands print the raw JSON API response — pipe to `jq`. See `docs/vikunja-api.md`
for the endpoint mapping and a couple of Vikunja API gotchas.
