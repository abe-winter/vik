# vik task tracking

this repo uses vikunja for task tracking via the `vik` CLI.

Useful commands:

```sh
# list undone tasks you've claimed (to restore context in case you got interrupted)
vik list --mine --done false --compact

# list tasks in blocker order
vik list --topo-sort --done false --compact

# claim a task
vik modify $TASK_ID --mine

# when a task is done, close it
vik modify $TASK_ID --done true
git commit ... # also commit the changes here, unless nothing changed

# for research tasks, add results as a comment.
# use `-` instead of text to if you want to read stdin.
# note this is html, not markdown
vik comment $TASK "comment goes here"

# you can also attach or download media with:
vik attach ...
vik attachments ...

# read comments on an existing ticket.
# this is useful in cases where we are exchanging feedback (but ideally we'll use matrix chat for that when available)
vik comments $ID
```
