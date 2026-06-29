# vik task tracking

this repo uses vikunja for task tracking via the `vik` CLI.

Useful commands:

```sh
# list undone tasks you've claimed (to restore context in case you got interrupted)
vik list --mine --done false

# list tasks in blocker order
vik list --topo-sort --done false

# claim a task
vik modify $TASK_ID --mine

# when a task is done, close it
vik modify $TASK_ID --done true
git commit ... # also commit the changes here, unless nothing changed

# for research tasks, add results as a comment
# use `-` instead of text to read stdin
vik comment $TASK "comment goes here"

# you can also attach or download media with
vik attach ...
vik attachments ...
```
